import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const OPERATION_ID_DESCRIPTION =
  "Stable ID for this logical side-effecting operation. Reuse the same ID only when retrying the exact same request after an unknown or lost response; use a new ID for a new operation.";

const DEFAULT_RECEIPT_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_RECEIPTS = 1_000;
const DEFAULT_MAX_TOMBSTONES = 100_000;

type StoredReceipt = {
  fingerprint: string;
  promise: Promise<unknown>;
  settledAt?: number;
};

type Tombstone = {
  fingerprint: string;
};

export interface OperationReceiptManagerOptions {
  receiptTtlMs?: number;
  maxReceipts?: number;
  maxTombstones?: number;
  now?: () => number;
  stateDir?: string;
}

interface PersistedReceiptRow {
  workspace_id: string;
  operation_id: string;
  fingerprint: string;
  status: "pending" | "completed" | "failed" | "tombstone";
  result_json: string | null;
  error_message: string | null;
  created_at: number;
  settled_at: number | null;
}

export interface RunRecoverableOperationInput<T> {
  workspaceId: string;
  operationId: string;
  tool: string;
  request: unknown;
  execute: () => Promise<T>;
}

export interface RecoverableOperationResult<T> {
  value: T;
  replayed: boolean;
}

export class OperationReceiptManager {
  private readonly receipts = new Map<string, StoredReceipt>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly receiptTtlMs: number;
  private readonly maxReceipts: number;
  private readonly maxTombstones: number;
  private readonly now: () => number;
  private readonly dbPath?: string;

  constructor(options: OperationReceiptManagerOptions = {}) {
    this.receiptTtlMs = options.receiptTtlMs ?? DEFAULT_RECEIPT_TTL_MS;
    this.maxReceipts = options.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
    this.maxTombstones = options.maxTombstones ?? DEFAULT_MAX_TOMBSTONES;
    this.now = options.now ?? Date.now;

    if (!Number.isFinite(this.receiptTtlMs) || this.receiptTtlMs < 0) {
      throw new Error("Operation receipt TTL must be a non-negative number.");
    }
    if (!Number.isInteger(this.maxReceipts) || this.maxReceipts < 1) {
      throw new Error("Operation receipt capacity must be a positive integer.");
    }
    if (!Number.isInteger(this.maxTombstones) || this.maxTombstones < 1) {
      throw new Error("Operation tombstone capacity must be a positive integer.");
    }
    if (options.stateDir) {
      const operationDir = path.join(options.stateDir, "operations");
      mkdirSync(operationDir, { recursive: true });
      this.dbPath = path.join(operationDir, "operation-receipts.sqlite");
      this.withDb((db) => {
        db.pragma("journal_mode = WAL");
        db.exec(`
          CREATE TABLE IF NOT EXISTS operation_receipts (
            workspace_id TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            status TEXT NOT NULL,
            result_json TEXT,
            error_message TEXT,
            created_at INTEGER NOT NULL,
            settled_at INTEGER,
            PRIMARY KEY (workspace_id, operation_id)
          );
          CREATE INDEX IF NOT EXISTS idx_operation_receipts_status
            ON operation_receipts (status, settled_at);
        `);
      });
    }
  }

  async run<T>(input: RunRecoverableOperationInput<T>): Promise<RecoverableOperationResult<T>> {
    validateOperationId(input.operationId);
    this.compactExpiredReceipts();

    const key = receiptKey(input.workspaceId, input.operationId);
    const fingerprint = requestFingerprint(input.tool, input.request);
    const receipt = this.receipts.get(key);
    if (receipt) {
      assertFingerprintMatches(input.operationId, receipt.fingerprint, fingerprint);
      return {
        value: await receipt.promise as T,
        replayed: true,
      };
    }

    const tombstone = this.tombstones.get(key);
    if (tombstone) {
      assertFingerprintMatches(input.operationId, tombstone.fingerprint, fingerprint);
      throw new Error(
        `Operation ${input.operationId} was already executed, but its stored result has expired. Do not execute it again; inspect current state and use a new operationId for any new action.`,
      );
    }

    const persisted = this.persistedReceipt(input.workspaceId, input.operationId);
    if (persisted) {
      assertFingerprintMatches(input.operationId, persisted.fingerprint, fingerprint);
      if (persisted.status === "completed") {
        return {
          value: deserializeResult<T>(persisted.result_json),
          replayed: true,
        };
      }
      if (persisted.status === "failed") {
        throw new Error(persisted.error_message || `Operation ${input.operationId} previously failed.`);
      }
      if (persisted.status === "pending") {
        throw new Error(
          `Operation ${input.operationId} was in-flight when DevSpace restarted or lost its response. Its outcome is unknown, so DevSpace will not execute it again. Inspect current state and use a new operationId only for a genuinely new action.`,
        );
      }
      throw new Error(
        `Operation ${input.operationId} was already executed, but its stored result has expired. Do not execute it again; inspect current state and use a new operationId for any new action.`,
      );
    }

    if (this.liveReceiptCount() >= this.maxReceipts) {
      throw new Error(
        "Operation receipt capacity reached. Refusing a new side-effecting operation rather than evicting a receipt that may still be needed for safe retry.",
      );
    }

    this.insertPendingReceipt(input.workspaceId, input.operationId, fingerprint);

    const stored: StoredReceipt = {
      fingerprint,
      promise: Promise.resolve().then(input.execute),
    };
    this.receipts.set(key, stored);
    void stored.promise.then(
      (value) => {
        stored.settledAt = this.now();
        this.persistCompletedReceipt(input.workspaceId, input.operationId, value, stored.settledAt);
      },
      (error) => {
        stored.settledAt = this.now();
        this.persistFailedReceipt(
          input.workspaceId,
          input.operationId,
          error instanceof Error ? error.message : String(error),
          stored.settledAt,
        );
      },
    );

    return {
      value: await stored.promise as T,
      replayed: false,
    };
  }

  private compactExpiredReceipts(): void {
    const now = this.now();
    if (this.dbPath) {
      const cutoff = now - this.receiptTtlMs;
      this.withDb((db) => {
        const tombstones = db.prepare(
          "SELECT COUNT(*) AS count FROM operation_receipts WHERE status = 'tombstone'",
        ).get() as { count: number };
        const expiring = db.prepare(
          "SELECT COUNT(*) AS count FROM operation_receipts WHERE status IN ('completed','failed') AND settled_at IS NOT NULL AND settled_at <= ?",
        ).get(cutoff) as { count: number };
        if (tombstones.count + expiring.count > this.maxTombstones) {
          throw new Error(
            "Operation tombstone capacity reached. Refusing further side-effecting operations until old receipt state is explicitly maintained, so an old operation ID can never be silently reused.",
          );
        }
        db.prepare(`
          UPDATE operation_receipts
          SET status = 'tombstone', result_json = NULL, error_message = NULL
          WHERE status IN ('completed','failed')
            AND settled_at IS NOT NULL
            AND settled_at <= ?
        `).run(cutoff);
      });
    }
    for (const [key, receipt] of this.receipts) {
      if (receipt.settledAt === undefined || now - receipt.settledAt < this.receiptTtlMs) {
        continue;
      }
      if (this.tombstones.size >= this.maxTombstones) {
        throw new Error(
          "Operation tombstone capacity reached. Refusing further side-effecting operations until DevSpace is restarted, so an old operation ID can never be silently reused.",
        );
      }
      this.receipts.delete(key);
      this.tombstones.set(key, { fingerprint: receipt.fingerprint });
    }
  }

  close(): void {}

  private persistedReceipt(workspaceId: string, operationId: string): PersistedReceiptRow | undefined {
    if (!this.dbPath) return undefined;
    return this.withDb((db) => db.prepare(
      "SELECT * FROM operation_receipts WHERE workspace_id = ? AND operation_id = ?",
    ).get(workspaceId, operationId) as PersistedReceiptRow | undefined);
  }

  private liveReceiptCount(): number {
    if (!this.dbPath) return this.receipts.size;
    return this.withDb((db) => {
      const row = db.prepare(
        "SELECT COUNT(*) AS count FROM operation_receipts WHERE status != 'tombstone'",
      ).get() as { count: number };
      return row.count;
    }) ?? 0;
  }

  private insertPendingReceipt(workspaceId: string, operationId: string, fingerprint: string): void {
    if (!this.dbPath) return;
    this.withDb((db) => db.prepare(`
        INSERT INTO operation_receipts (
          workspace_id, operation_id, fingerprint, status,
          result_json, error_message, created_at, settled_at
        ) VALUES (?, ?, ?, 'pending', NULL, NULL, ?, NULL)
      `).run(workspaceId, operationId, fingerprint, this.now()));
  }

  private persistCompletedReceipt(
    workspaceId: string,
    operationId: string,
    value: unknown,
    settledAt: number,
  ): void {
    if (!this.dbPath) return;
    this.withDb((db) => db.prepare(`
        UPDATE operation_receipts
        SET status = 'completed', result_json = ?, error_message = NULL, settled_at = ?
        WHERE workspace_id = ? AND operation_id = ? AND status = 'pending'
      `).run(serializeResult(value), settledAt, workspaceId, operationId));
  }

  private persistFailedReceipt(
    workspaceId: string,
    operationId: string,
    message: string,
    settledAt: number,
  ): void {
    if (!this.dbPath) return;
    this.withDb((db) => db.prepare(`
        UPDATE operation_receipts
        SET status = 'failed', result_json = NULL, error_message = ?, settled_at = ?
        WHERE workspace_id = ? AND operation_id = ? AND status = 'pending'
      `).run(message, settledAt, workspaceId, operationId));
  }

  private withDb<T>(operation: (db: Database.Database) => T): T | undefined {
    if (!this.dbPath) return undefined;
    const db = new Database(this.dbPath);
    try {
      return operation(db);
    } finally {
      db.close();
    }
  }
}

const operationReceiptManagers = new Map<string, OperationReceiptManager>();

function operationReceiptManager(stateDir?: string): OperationReceiptManager {
  if (!stateDir) {
    const key = "<memory>";
    let manager = operationReceiptManagers.get(key);
    if (!manager) {
      manager = new OperationReceiptManager();
      operationReceiptManagers.set(key, manager);
    }
    return manager;
  }
  const key = path.resolve(stateDir);
  let manager = operationReceiptManagers.get(key);
  if (!manager) {
    manager = new OperationReceiptManager({ stateDir: key });
    operationReceiptManagers.set(key, manager);
  }
  return manager;
}

export async function runRecoverableOperation<T>(
  input: RunRecoverableOperationInput<T> & { stateDir?: string },
): Promise<RecoverableOperationResult<T>> {
  return operationReceiptManager(input.stateDir).run(input);
}

export async function runOptionalRecoverableOperation<T>(input: {
  workspaceId: string;
  stateDir?: string;
  operationId?: string;
  tool: string;
  request: unknown;
  execute: () => Promise<T>;
}): Promise<RecoverableOperationResult<T>> {
  if (!input.operationId) {
    return { value: await input.execute(), replayed: false };
  }
  return runRecoverableOperation({
    workspaceId: input.workspaceId,
    stateDir: input.stateDir,
    operationId: input.operationId,
    tool: input.tool,
    request: input.request,
    execute: input.execute,
  });
}

export function closeOperationReceiptManager(stateDir: string): void {
  const key = path.resolve(stateDir);
  const manager = operationReceiptManagers.get(key);
  if (!manager) return;
  operationReceiptManagers.delete(key);
  manager.close();
}

export function recoverableStructuredContent<T extends Record<string, unknown>>(
  structuredContent: T,
  operationId: string,
  replayed: boolean,
): T & { operationId: string; operationReplayed: boolean } {
  return {
    ...structuredContent,
    operationId,
    operationReplayed: replayed,
  };
}

function receiptKey(workspaceId: string, operationId: string): string {
  return `${workspaceId}\u0000${operationId}`;
}

function requestFingerprint(tool: string, request: unknown): string {
  return createHash("sha256")
    .update(tool)
    .update("\u0000")
    .update(canonicalJson(request))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

function serializeResult(value: unknown): string {
  return JSON.stringify({ value });
}

function deserializeResult<T>(serialized: string | null): T {
  if (!serialized) return undefined as T;
  return (JSON.parse(serialized) as { value?: T }).value as T;
}

function validateOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error(
      "operationId must be 8-128 characters and contain only letters, digits, '.', '_', ':', or '-', starting with a letter or digit.",
    );
  }
}

function assertFingerprintMatches(
  operationId: string,
  expected: string,
  actual: string,
): void {
  if (expected !== actual) {
    throw new Error(
      `Operation ${operationId} was already used for a different request. Reuse an operationId only for an exact retry of the same tool call.`,
    );
  }
}
