import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { migrateDatabase } from "./migrations.js";

export type SqliteDatabase = Database.Database;
export type AppDatabase = ReturnType<typeof createDrizzleDatabase>;

export interface DatabaseHandle {
  readonly sqlite: SqliteDatabase;
  readonly db: AppDatabase;
  close(): void;
}

export class DatabaseHandleClosedError extends Error {
  constructor(path: string) {
    super(`Database handle for ${path} has been closed; acquire a new handle with openDatabase(stateDir)`);
    this.name = "DatabaseHandleClosedError";
  }
}

interface SharedDatabase {
  readonly path: string;
  readonly sqlite: SqliteDatabase;
  readonly db: AppDatabase;
  refs: number;
  closed: boolean;
}

// One SQLite connection per resolved database file, shared by every store in the process.
const sharedDatabases = new Map<string, SharedDatabase>();

export function databasePath(stateDir: string): string {
  return join(stateDir, "devspace.sqlite");
}

export function openDatabase(stateDir: string): DatabaseHandle {
  const { key, path } = resolveDatabaseKey(stateDir);
  const shared = sharedDatabases.get(key) ?? openSharedDatabase(key, path);

  shared.refs += 1;
  let released = false;

  const requireOpen = (): SharedDatabase => {
    if (released) throw new DatabaseHandleClosedError(shared.path);
    if (shared.closed) throw new DatabaseHandleClosedError(shared.path);
    return shared;
  };

  return {
    get sqlite(): SqliteDatabase {
      return requireOpen().sqlite;
    },
    get db(): AppDatabase {
      return requireOpen().db;
    },
    close(): void {
      if (released) return;
      released = true;
      shared.refs -= 1;
      if (shared.refs > 0) return;
      shared.closed = true;
      if (sharedDatabases.get(key) === shared) sharedDatabases.delete(key);
      shared.sqlite.close();
    },
  };
}

function resolveDatabaseKey(stateDir: string): { key: string; path: string } {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  // Resolve the symlinked directory and, when the file already exists, the file itself.
  const path = databasePath(realpathSync(stateDir));
  try {
    return { key: realpathSync(path), path };
  } catch {
    return { key: path, path };
  }
}

function openSharedDatabase(key: string, path: string): SharedDatabase {
  const sqlite = new Database(path);
  try {
    chmodSync(path, 0o600);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("foreign_keys = ON");
    migrateDatabase(sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }

  const shared: SharedDatabase = {
    path,
    sqlite,
    db: createDrizzleDatabase(sqlite),
    refs: 0,
    closed: false,
  };
  sharedDatabases.set(key, shared);
  return shared;
}

function createDrizzleDatabase(sqlite: SqliteDatabase) {
  return drizzle(sqlite, { schema });
}
