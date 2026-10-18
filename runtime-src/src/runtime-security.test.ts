import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import type { Response } from "express";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { SqliteOAuthStore } from "./oauth-store.js";
import { openDatabase } from "./db/client.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { ProcessRunLogger } from "./compact-runtime/process-run-store.js";
import { writeDevspaceAuth, loadDevspaceFiles } from "./user-config.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "devspace-runtime-security-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const oauthConfig = {
  ownerToken: "synthetic-owner-password",
  accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 7200,
  scopes: ["devspace"], allowedResourceUrls: [], allowedRedirectHosts: [],
};

test("owner password failures back off per IP and globally, success resets the client", async (t) => {
  const provider = new SingleUserOAuthProvider(oauthConfig, new URL("https://agent.example.com/mcp"), fixture(t));
  t.after(() => provider.close());
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ["http://localhost/callback"] });
  const params = { redirectUri: "http://localhost/callback", codeChallenge: "challenge", scopes: ["devspace"], resource: new URL("https://agent.example.com/mcp") };
  async function login(ip: string, password: string) {
    const reply = { statusCode: 0, body: "", redirected: false };
    const res = {
      req: { method: "POST", ip, body: { owner_token: password } },
      status(code: number) { reply.statusCode = code; return this; },
      setHeader() { return this; },
      send(body: string) { reply.body = body; },
      redirect(code: number) { reply.statusCode = code; reply.redirected = true; },
    } as unknown as Response;
    await provider.authorize(client, params, res);
    return reply;
  }
  const first = await login("192.0.2.1", "wrong");
  assert.equal(first.statusCode, 401);
  const blocked = await login("192.0.2.2", oauthConfig.ownerToken);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.body, first.body, "same generic error for rejection and throttling");
  t.mock.timers.setTime(1_001_001);
  assert.equal((await login("192.0.2.1", "still-wrong")).statusCode, 401);
  t.mock.timers.setTime(1_002_002);
  assert.equal((await login("192.0.2.1", oauthConfig.ownerToken)).statusCode, 429, "second failure doubles backoff");
  t.mock.timers.setTime(1_003_002);
  assert.equal((await login("192.0.2.1", oauthConfig.ownerToken)).redirected, true);
  assert.equal(provider["loginFailures"].has("192.0.2.1"), false);
  assert.equal((await login("192.0.2.1", "wrong-again")).statusCode, 401);
  assert.equal(provider["loginFailures"].get("192.0.2.1")?.count, 1);
  assert.ok(provider["loginFailures"].size <= 1024);
});

test("OAuth registration evicts the oldest token-free client at 200 and issuance prunes expired tokens", (t) => {
  const root = fixture(t);
  const store = new SqliteOAuthStore(root);
  const database = openDatabase(root);
  t.after(() => { store.close(); database.close(); });
  const clients = Array.from({ length: 200 }, () => store.registerClient({ redirect_uris: ["http://localhost/callback"] }, []));
  const now = Math.floor(Date.now() / 1000);
  database.sqlite.prepare("update oauth_clients set issued_at = ? where client_id = ?").run(now - 2, clients[2]!.client_id);
  database.sqlite.prepare("update oauth_clients set issued_at = ? where client_id = ?").run(now - 3, clients[1]!.client_id);
  store.saveAccessToken("live-access", { clientId: clients[1]!.client_id, scopes: [], expiresAt: now + 7200 });
  store.saveRefreshToken("live-refresh", { clientId: clients[0]!.client_id, scopes: [], expiresAt: now + 7200 });
  store.saveAccessToken("expired-access", { clientId: clients[2]!.client_id, scopes: [], expiresAt: now - 1 });
  store.saveRefreshToken("expired-refresh", { clientId: clients[2]!.client_id, scopes: [], expiresAt: now });
  const replacement = store.registerClient({ redirect_uris: ["http://localhost/callback"] }, []);
  assert.equal(store.getClient(clients[2]!.client_id), undefined, "oldest eligible client is evicted");
  for (const index of [0, 1, 3]) assert.ok(store.getClient(clients[index]!.client_id));
  assert.ok(store.getClient(replacement.client_id));
  assert.ok(store.getAccessToken("live-access"));
  assert.ok(store.getRefreshToken("live-refresh"));
  assert.equal(store.getAccessToken("expired-access"), undefined, "eviction cascades to expired tokens");
  assert.equal(store.getRefreshToken("expired-refresh"), undefined);
  store.saveAccessToken("expired-access", { clientId: clients[0]!.client_id, scopes: [], expiresAt: now - 1 });
  store.saveRefreshToken("expired-refresh", { clientId: clients[0]!.client_id, scopes: [], expiresAt: now - 1 });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 3601_000 });
  store.saveTokenPair({
    accessTokenHash: "new-access", accessToken: { clientId: clients[0]!.client_id, scopes: [], expiresAt: now + 7200 },
    refreshTokenHash: "new-refresh", refreshToken: { clientId: clients[0]!.client_id, scopes: [], expiresAt: now + 7200 },
  });
  assert.equal(store.getAccessToken("expired-access"), undefined);
  assert.equal(store.getRefreshToken("expired-refresh"), undefined);
  assert.ok(store.getAccessToken("new-access"));
  assert.equal((database.sqlite.prepare("select count(*) as n from oauth_clients").get() as { n: number }).n, 200);
});

test("OAuth registration rejects at 200 when every client has an unexpired access or refresh token", (t) => {
  const root = fixture(t);
  const store = new SqliteOAuthStore(root);
  const database = openDatabase(root);
  t.after(() => { store.close(); database.close(); });
  const now = Math.floor(Date.now() / 1000);
  const clients = Array.from({ length: 200 }, (_, index) => {
    const client = store.registerClient({ redirect_uris: ["http://localhost/callback"] }, []);
    const record = { clientId: client.client_id, scopes: [], expiresAt: now + 3600 };
    if (index % 2) store.saveAccessToken(`access-${index}`, record);
    else store.saveRefreshToken(`refresh-${index}`, record);
    return client;
  });
  assert.throws(() => store.registerClient({ redirect_uris: ["http://localhost/callback"] }, []), /registration limit of 200.*live tokens/);
  for (const client of clients) assert.ok(store.getClient(client.client_id));
  assert.equal((database.sqlite.prepare("select count(*) as n from oauth_clients").get() as { n: number }).n, 200);
});

test("auth file replacement preserves the previous file inode and writes a private complete replacement", (t) => {
  const root = fixture(t);
  const env = { DEVSPACE_CONFIG_DIR: root };
  const authPath = writeDevspaceAuth({ ownerToken: "synthetic-before" }, env);
  const previous = statSync(authPath).ino;
  writeDevspaceAuth({ ownerToken: "synthetic-after" }, env);
  assert.equal(JSON.parse(readFileSync(authPath, "utf8")).ownerToken, "synthetic-after");
  if (process.platform !== "win32") {
    assert.notEqual(statSync(authPath).ino, previous);
    assert.equal(statSync(authPath).mode & 0o777, 0o600);
  }
  assert.equal(readdirSync(root).some(name => name.endsWith(".tmp")), false);
  assert.equal(loadDevspaceFiles(env).auth.ownerToken, "synthetic-after");
});

const node = process.platform === "win32" ? `"${process.execPath}"` : JSON.stringify(process.execPath);

test("process session cap counts running sessions and evicts completed retained sessions", async (t) => {
  const root = fixture(t);
  const manager = new ProcessSessionManager();
  t.after(() => manager.shutdown());
  assert.equal(manager["maxRuntimeMs"], 8 * 60 * 60_000);
  assert.equal(manager["idleTimeoutMs"], 2 * 60 * 60_000);
  const input = { workspaceId: "test", cwd: root, command: "echo available", yieldTimeMs: 1000 };
  const retained = manager["createSession"](input);
  manager["sessions"].set(retained.id, retained);
  manager["finish"](retained, 0);
  const running = Array.from({ length: 9 }, () => {
    const session = manager["createSession"](input);
    manager["sessions"].set(session.id, session);
    return session;
  });
  assert.equal((await manager.start(input)).running, false);
  assert.equal(manager["sessions"].has(retained.id), false);
  const tenth = manager["createSession"](input);
  manager["sessions"].set(tenth.id, tenth);
  await assert.rejects(manager.start(input), /limit of 10 running sessions.*terminate.*free a slot/);
  manager["finish"](running[0]!, 0);
  assert.equal((await manager.start(input)).exitCode, 0);
});

test("process exit state and timers settle before log flush while final output waits for all bytes", async (t) => {
  const root = fixture(t);
  const manager = new ProcessSessionManager({ runRoot: root });
  t.after(() => manager.shutdown());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = manager["createSession"]({ workspaceId: "test", cwd: root, command: "synthetic" });
  manager["sessions"].set(session.id, session);
  session.logger = await ProcessRunLogger.create({ root, cwd: root, workspaceRoot: root, command: "synthetic" });
  let releaseFlush!: () => void;
  const blockedFlush = new Promise<void>(resolve => { releaseFlush = resolve; });
  t.after(releaseFlush);
  const originalFinish = session.logger.finish.bind(session.logger);
  t.mock.method(session.logger, "finish", async (input: Parameters<ProcessRunLogger["finish"]>[0]) => { await blockedFlush; return originalFinish(input); });
  const touched = t.mock.fn();
  session.process = { write: touched, kill: touched, resize: touched };
  session.cleanupTimer = setTimeout(touched, 10);
  session.lifetimeTimer = setTimeout(touched, 10);
  manager["resetIdleTimer"](session);
  manager["append"](session, "all final bytes\n");
  manager["finish"](session, 0);
  assert.equal(session.running, false);
  assert.equal(session.exitCode, 0);
  assert.equal(session.lifetimeTimer, undefined);
  assert.equal(session.idleTimer, undefined);
  await manager["waitForExit"](session, 1000);
  let returned = false;
  const final = manager.write({ workspaceId: "test", sessionId: session.id, chars: "ignored\u0003", columns: 99 })
    .then(snapshot => { returned = true; return snapshot; });
  manager["resetIdleTimer"](session);
  t.mock.timers.tick(2 * 60 * 60_000 + 1);
  assert.equal(touched.mock.callCount(), 0);
  assert.equal(session.idleTimer, undefined);
  assert.equal(returned, false);
  releaseFlush();
  const snapshot = await final;
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.exitCode, 0);
  assert.equal(snapshot.output, "all final bytes\n");
  assert.equal(readFileSync(session.logger.outputPath, "utf8"), snapshot.output);
  assert.equal(snapshot.outputBytes, Buffer.byteLength(snapshot.output));
});

test("stdout and stderr share one drain and an older drain cannot resume a newer pause", async (t) => {
  const root = fixture(t);
  const manager = new ProcessSessionManager({ runRoot: root });
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const spawnMock = t.mock.method(childProcess, "spawn", () => child as unknown as ChildProcess);
  syncBuiltinESMExports();
  t.after(() => { spawnMock.mock.restore(); syncBuiltinESMExports(); manager.shutdown(); });
  const started = await manager.start({ workspaceId: "test", cwd: root, command: "synthetic", yieldTimeMs: 0 });
  const session = manager["sessions"].get(started.sessionId!)!;
  const stdoutResume = t.mock.method(child.stdout, "resume");
  const stderrResume = t.mock.method(child.stderr, "resume");
  const stdoutPause = t.mock.method(child.stdout, "pause");
  const stderrPause = t.mock.method(child.stderr, "pause");
  const releases: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  t.mock.method(session.logger!, "append", () => false);
  const drain = t.mock.method(session.logger!, "drain", async () => {
    peak = Math.max(peak, ++active);
    await new Promise<void>(resolve => releases.push(resolve));
    active--;
  });
  child.stdout.emit("data", Buffer.from("out"));
  child.stderr.emit("data", Buffer.from("err"));
  assert.equal(drain.mock.callCount(), 1);
  assert.equal(stdoutPause.mock.callCount(), 2);
  assert.equal(stderrPause.mock.callCount(), 2);
  releases.shift()!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drain.mock.callCount(), 2);
  assert.equal(stdoutResume.mock.callCount(), 0);
  assert.equal(stderrResume.mock.callCount(), 0);
  child.stdout.emit("data", Buffer.from("newer"));
  releases.shift()!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drain.mock.callCount(), 3);
  assert.equal(stdoutResume.mock.callCount(), 0);
  releases.shift()!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peak, 1);
  assert.equal(stdoutResume.mock.callCount(), 1);
  assert.equal(stderrResume.mock.callCount(), 1);
  child.emit("close", 0, null);
  const result = await manager.write({ workspaceId: "test", sessionId: started.sessionId! });
  assert.equal(result.running, false);
  assert.equal(result.output, "outerrnewer");
});

test("interactive sessions reserve capacity before asynchronous launch and expire by wall-clock or idle limit", async (t) => {
  const root = fixture(t);
  for (const tty of process.platform === "win32" ? [false] : [false, true]) {
  for (const expiry of ["lifetime", "idle"]) {
    const manager = new ProcessSessionManager({ maxSessions: 1, runRoot: root,
      maxRuntimeMs: expiry === "lifetime" ? 150 : 10_000, idleTimeoutMs: expiry === "idle" ? 150 : 10_000 });
    try {
      const pending = manager.start({ workspaceId: "test", cwd: root, command: `${node} -e "setInterval(()=>{},1000)"`, tty, yieldTimeMs: 0 });
      await assert.rejects(manager.start({ workspaceId: "test", cwd: root, command: "echo forbidden" }), /session limit/);
      const started = await pending;
      assert.ok(started.sessionId);
      await new Promise(resolve => setTimeout(resolve, 350));
      const ended = await manager.write({ workspaceId: "test", sessionId: started.sessionId, yieldTimeMs: 1000 });
      assert.equal(ended.running, false, expiry);
    } finally { manager.shutdown(); }
  }
  }
});

test("interactive commands resolve project environment for cwd and explicit workspace root", { skip: process.platform === "win32" }, async (t) => {
  const root = fixture(t);
  const testHome = join(root, "home");
  const project = join(root, "project");
  const selectedBin = join(testHome, ".nvm", "versions", "node", "v99.0.0", "bin");
  mkdirSync(selectedBin, { recursive: true });
  mkdirSync(project);
  writeFileSync(join(project, ".nvmrc"), "99");
  const originalHome = process.env.HOME;
  process.env.HOME = testHome;
  t.after(() => { if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome; });
  const manager = new ProcessSessionManager();
  try {
    for (const explicit of [false, true]) {
      const result = await manager.start({ workspaceId: "test", cwd: explicit ? root : project,
        workspaceRoot: explicit ? project : undefined,
        command: `${node} -e "console.log(process.env.PATH)"`, yieldTimeMs: 2000 });
      assert.equal(result.running, false);
      assert.ok(result.output.includes(selectedBin + delimiter));
    }
  } finally { manager.shutdown(); }
});

test("pipe command logging drains stdout and stderr without losing output", async (t) => {
  const root = fixture(t);
  const manager = new ProcessSessionManager({ runRoot: root, maxBufferCharacters: 1000 });
  try {
    const result = await manager.start({ workspaceId: "test", cwd: root, yieldTimeMs: 12_000,
      command: `${node} -e "process.stdout.write('x'.repeat(1024*1024));process.stderr.write('y'.repeat(1024*1024))"` });
    assert.equal(result.running, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputBytes, 2 * 1024 * 1024);
    assert.equal(result.logError, undefined);
    const day = readdirSync(root)[0]!;
    const stored = readFileSync(join(root, day, result.runId!, "output.log"), "utf8");
    assert.equal(stored.length, 2 * 1024 * 1024);
    assert.equal(stored.replaceAll("x", "").length, 1024 * 1024);
    assert.equal(stored.replaceAll("y", "").length, 1024 * 1024);
  } finally { manager.shutdown(); }
});
