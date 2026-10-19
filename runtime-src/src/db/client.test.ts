import assert from "node:assert/strict";
import { existsSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalAgentStore } from "../local-agent-store.js";
import { SqliteOAuthStore } from "../oauth-store.js";
import { SqliteWorkspaceStore } from "../workspace-store.js";
import { WorkflowSessionManager } from "../workflow-sessions.js";
import { DatabaseHandleClosedError, databasePath, openDatabase, type DatabaseHandle } from "./client.js";

function tempRoot(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "devspace-db-client-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function handleOf(store: SqliteOAuthStore | SqliteWorkspaceStore | WorkflowSessionManager | LocalAgentStore): DatabaseHandle {
  return (store as unknown as { database: DatabaseHandle }).database;
}

test("four stores on one state dir share a single connection and schema", (t) => {
  const stateDir = join(tempRoot(t), "state");
  const oauth = new SqliteOAuthStore(stateDir);
  const workspace = new SqliteWorkspaceStore(stateDir);
  const workflows = new WorkflowSessionManager(stateDir);
  const agents = new LocalAgentStore(stateDir);
  t.after(() => { oauth.close(); workspace.close(); workflows.close(); agents.close(); });

  const handles = [oauth, workspace, workflows, agents].map(handleOf);
  const sqliteConnections = new Set(handles.map((handle) => handle.sqlite));
  const drizzleDatabases = new Set(handles.map((handle) => handle.db));
  assert.equal(sqliteConnections.size, 1, "all stores share one better-sqlite3 connection");
  assert.equal(drizzleDatabases.size, 1, "all stores share one drizzle wrapper");

  const direct = openDatabase(stateDir);
  assert.equal(direct.sqlite, handles[0]!.sqlite, "a later acquire reuses the same connection");
  const applied = direct.sqlite
    .prepare("select count(*) as n from devspace_schema_migrations")
    .get() as { n: number };
  assert.ok(applied.n > 0, "migrations ran on the first acquire");
  direct.close();
});

test("the connection stays open until the last handle is released, then the file is closable", (t) => {
  const stateDir = join(tempRoot(t), "state");
  const path = databasePath(stateDir);
  const first = openDatabase(stateDir);
  const second = openDatabase(stateDir);
  const third = openDatabase(stateDir);
  const originalSqlite = first.sqlite;
  assert.equal(first.sqlite, second.sqlite);
  assert.equal(second.sqlite, third.sqlite);

  first.close();
  second.close();
  assert.equal((third.sqlite.prepare("select count(*) as n from devspace_schema_migrations").get() as { n: number }).n > 0, true);
  assert.ok(existsSync(path), "file still exists while one handle is live");
  assert.ok(existsSync(`${path}-wal`), "WAL is still attached while a handle is live");

  third.close();
  assert.throws(() => third.sqlite, DatabaseHandleClosedError);
  assert.throws(() => first.db, DatabaseHandleClosedError);
  assert.equal(existsSync(`${path}-wal`), false, "last release checkpoints and removes the WAL file");
  assert.equal(existsSync(`${path}-shm`), false, "last release removes the shared-memory file");

  // Renaming the closed database proves no handle holds it open (fails on Windows with EBUSY otherwise).
  const moved = `${path}.moved`;
  renameSync(path, moved);
  renameSync(moved, path);

  const reopened = openDatabase(stateDir);
  assert.notEqual(reopened.sqlite, originalSqlite, "a new acquire after the final release opens a fresh connection");
  reopened.close();
});

test("two state dirs keep independent connections and contents", (t) => {
  const root = tempRoot(t);
  const firstDir = join(root, "first");
  const secondDir = join(root, "second");
  const first = openDatabase(firstDir);
  const second = openDatabase(secondDir);
  t.after(() => { first.close(); second.close(); });
  assert.notEqual(first.sqlite, second.sqlite);

  first.sqlite.exec("create table shared_marker (value text)");
  const inSecond = second.sqlite
    .prepare("select name from sqlite_master where type = 'table' and name = 'shared_marker'")
    .get();
  assert.equal(inSecond, undefined, "schema changes do not leak across state dirs");
  const firstAgain = openDatabase(firstDir);
  t.after(() => firstAgain.close());
  assert.equal(firstAgain.sqlite, first.sqlite);
});

test("a symlinked state dir resolves to the same shared connection", (t) => {
  if (process.platform === "win32") {
    t.skip("directory symlinks need extra privileges on Windows");
    return;
  }
  const root = tempRoot(t);
  const stateDir = join(root, "state");
  const alias = join(root, "alias");
  const first = openDatabase(stateDir);
  symlinkSync(stateDir, alias, "dir");
  const throughAlias = openDatabase(alias);
  t.after(() => { first.close(); throughAlias.close(); });

  assert.equal(throughAlias.sqlite, first.sqlite, "the registry is keyed by the resolved real path");
});

test("double release is a no-op and use after final close throws clearly", (t) => {
  const stateDir = join(tempRoot(t), "state");
  const first = openDatabase(stateDir);
  const second = openDatabase(stateDir);

  first.close();
  first.close();
  assert.throws(() => first.sqlite, DatabaseHandleClosedError);
  assert.throws(() => first.db, DatabaseHandleClosedError);

  second.sqlite.prepare("select 1").get();
  second.close();
  second.close();
  assert.throws(() => second.sqlite, (error: unknown) => {
    assert.ok(error instanceof DatabaseHandleClosedError);
    assert.match(error.message, /has been closed/);
    return true;
  });

  const fresh = openDatabase(stateDir);
  fresh.close();
});

test("repeated concurrent-style acquires still yield one connection", (t) => {
  const stateDir = join(tempRoot(t), "state");
  const handles = Array.from({ length: 8 }, () => openDatabase(stateDir));
  t.after(() => { for (const handle of handles) handle.close(); });
  assert.equal(new Set(handles.map((handle) => handle.sqlite)).size, 1);
  assert.equal(new Set(handles.map((handle) => handle.db)).size, 1);
  for (const handle of handles.slice(0, -1)) handle.close();
  const survivor = handles.at(-1)!;
  assert.equal((survivor.sqlite.prepare("select 1").get() as { "1": number })["1"], 1);
});
