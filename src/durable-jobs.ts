import { spawn } from "node:child_process";
import {
  openSync,
  closeSync,
  existsSync,
  mkdirSync,
  statSync,
  readSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { terminateProcessTree } from "./process-platform.js";

export interface JobRecord {
  id: string;
  workspaceId: string;
  workspaceRoot: string;
  command: string;
  workingDirectory: string;
  pid: number | null;
  pgid: number | null;
  status: "running" | "succeeded" | "failed" | "cancelled";
  exitCode: number | null;
  signal: string | null;
  logPath: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  lastHeartbeat: number;
  maxRuntimeSeconds: number;
  error: string | null;
}

interface RawJobRow {
  id: string;
  workspace_id: string;
  workspace_root: string;
  command: string;
  working_directory: string;
  pid: number | null;
  pgid: number | null;
  status: "running" | "succeeded" | "failed" | "cancelled";
  exit_code: number | null;
  signal: string | null;
  log_path: string;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  last_heartbeat: number;
  max_runtime_seconds: number;
  error: string | null;
}

export interface StartJobParams {
  workspaceId: string;
  workspaceRoot: string;
  command: string;
  workingDirectory: string;
  maxRuntimeSeconds?: number;
  env?: NodeJS.ProcessEnv;
}

export interface LogReadOptions {
  offset?: number;
  maxBytes?: number;
  tail?: boolean;
  maxLines?: number;
}

export interface JobLogsResult {
  jobId: string;
  content: string;
  totalBytes: number;
  hasMore: boolean;
  nextOffset: number;
}

export interface DurableJobManagerOptions {
  completedRetentionSeconds?: number;
  maxCompletedJobs?: number;
}

const DEFAULT_COMPLETED_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_MAX_COMPLETED_JOBS = 1_000;

export class DurableJobManager {
  private db: Database.Database;
  private jobsDir: string;
  private logsDir: string;
  private metadataDir: string;
  private heartbeatTimer?: NodeJS.Timeout;
  private completedRetentionSeconds: number;
  private maxCompletedJobs: number;

  constructor(stateDir: string, options: DurableJobManagerOptions = {}) {
    this.jobsDir = join(stateDir, "jobs");
    this.logsDir = join(this.jobsDir, "logs");
    this.metadataDir = join(this.jobsDir, "meta");
    this.completedRetentionSeconds = Math.max(
      60,
      Math.floor(options.completedRetentionSeconds ?? DEFAULT_COMPLETED_RETENTION_SECONDS),
    );
    this.maxCompletedJobs = Math.max(
      1,
      Math.floor(options.maxCompletedJobs ?? DEFAULT_MAX_COMPLETED_JOBS),
    );
    mkdirSync(this.logsDir, { recursive: true });
    mkdirSync(this.metadataDir, { recursive: true });

    const dbPath = join(this.jobsDir, "jobs.sqlite");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initDb();
    this.reconcile();
    this.pruneCompleted();
    this.startHeartbeat();
  }

  private initDb() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS durable_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        command TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        pid INTEGER,
        pgid INTEGER,
        status TEXT NOT NULL,
        exit_code INTEGER,
        signal TEXT,
        log_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        last_heartbeat INTEGER NOT NULL,
        max_runtime_seconds INTEGER NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_durable_jobs_workspace ON durable_jobs (workspace_id);
      CREATE INDEX IF NOT EXISTS idx_durable_jobs_status ON durable_jobs (status);
    `);
  }

  private rowToRecord(row: RawJobRow): JobRecord {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceRoot: row.workspace_root,
      command: row.command,
      workingDirectory: row.working_directory,
      pid: row.pid,
      pgid: row.pgid,
      status: row.status,
      exitCode: row.exit_code,
      signal: row.signal,
      logPath: row.log_path,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      lastHeartbeat: row.last_heartbeat,
      maxRuntimeSeconds: row.max_runtime_seconds,
      error: row.error,
    };
  }

  public getJob(id: string): JobRecord | null {
    // Check if detached finish marker exists on disk
    this.checkCompletionMarker(id);
    const row = this.db.prepare("SELECT * FROM durable_jobs WHERE id = ?").get(id) as
      | RawJobRow
      | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  public listJobs(workspaceId?: string, limit = 50, workspaceRoot?: string): JobRecord[] {
    let rows: RawJobRow[];
    if (workspaceId && workspaceRoot) {
      rows = this.db
        .prepare(
          "SELECT * FROM durable_jobs WHERE workspace_id = ? OR workspace_root = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(workspaceId, workspaceRoot, limit) as RawJobRow[];
    } else if (workspaceId) {
      rows = this.db
        .prepare("SELECT * FROM durable_jobs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(workspaceId, limit) as RawJobRow[];
    } else {
      rows = this.db
        .prepare("SELECT * FROM durable_jobs ORDER BY created_at DESC LIMIT ?")
        .all(limit) as RawJobRow[];
    }
    for (const r of rows) {
      this.checkCompletionMarker(r.id);
    }
    if (workspaceId && workspaceRoot) {
      rows = this.db
        .prepare(
          "SELECT * FROM durable_jobs WHERE workspace_id = ? OR workspace_root = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(workspaceId, workspaceRoot, limit) as RawJobRow[];
    } else if (workspaceId) {
      rows = this.db
        .prepare("SELECT * FROM durable_jobs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(workspaceId, limit) as RawJobRow[];
    } else {
      rows = this.db
        .prepare("SELECT * FROM durable_jobs ORDER BY created_at DESC LIMIT ?")
        .all(limit) as RawJobRow[];
    }
    return rows.map((r) => this.rowToRecord(r));
  }

  private getMarkerPath(id: string): string {
    return join(this.metadataDir, `${id}.exit`);
  }

  private checkCompletionMarker(id: string): void {
    const markerPath = this.getMarkerPath(id);
    if (existsSync(markerPath)) {
      try {
        const raw = readFileSync(markerPath, "utf8").trim();
        const parsed = JSON.parse(raw) as { exitCode: number; signal: string | null; endedAt: number };
        const finalStatus = parsed.exitCode === 0 ? "succeeded" : "failed";
        this.db
          .prepare(
            `
          UPDATE durable_jobs SET status = ?, exit_code = ?, signal = ?, ended_at = ?, last_heartbeat = ?
          WHERE id = ? AND status = 'running'
        `
          )
          .run(finalStatus, parsed.exitCode, parsed.signal, parsed.endedAt, parsed.endedAt, id);
      } catch {}
    }
  }

  public startJob(params: StartJobParams): JobRecord {
    const id = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = Math.floor(Date.now() / 1000);
    const maxRuntime =
      params.maxRuntimeSeconds && params.maxRuntimeSeconds > 0 ? params.maxRuntimeSeconds : 86400;
    const logPath = join(this.logsDir, `${id}.log`);
    const markerPath = this.getMarkerPath(id);

    const outFd = openSync(logPath, "a", 0o600);

    const mergedEnv = {
      ...process.env,
      ...params.env,
      DEVSPACE_JOB_ID: id,
    };

    let child;
    try {
      const compiledRunnerPath = fileURLToPath(new URL("./durable-job-runner.js", import.meta.url));
      const sourceRunnerPath = fileURLToPath(new URL("./durable-job-runner.ts", import.meta.url));
      const runnerArgs = existsSync(compiledRunnerPath)
        ? [compiledRunnerPath, markerPath, params.command]
        : ["--import", "tsx", sourceRunnerPath, markerPath, params.command];
      child = spawn(process.execPath, runnerArgs, {
        cwd: params.workingDirectory,
        env: mergedEnv,
        detached: true,
        stdio: ["ignore", outFd, outFd],
        windowsHide: true,
      });
    } catch (err: unknown) {
      closeSync(outFd);
      const errMsg = err instanceof Error ? err.message : String(err);
      const insert = this.db.prepare(`
        INSERT INTO durable_jobs (
          id, workspace_id, workspace_root, command, working_directory,
          pid, pgid, status, exit_code, signal, log_path,
          created_at, started_at, ended_at, last_heartbeat, max_runtime_seconds, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(
        id,
        params.workspaceId,
        params.workspaceRoot,
        params.command,
        params.workingDirectory,
        null,
        null,
        "failed",
        null,
        null,
        logPath,
        now,
        now,
        now,
        now,
        maxRuntime,
        errMsg
      );
      return this.getJob(id)!;
    } finally {
      // Fix finding 2: Close parent FD copy immediately so parent does not leak file descriptors
      try {
        closeSync(outFd);
      } catch {}
    }

    const pid = child.pid ?? null;
    const pgid = process.platform === "win32" ? null : pid;
    child.unref();

    const insert = this.db.prepare(`
      INSERT INTO durable_jobs (
        id, workspace_id, workspace_root, command, working_directory,
        pid, pgid, status, exit_code, signal, log_path,
        created_at, started_at, ended_at, last_heartbeat, max_runtime_seconds, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run(
      id,
      params.workspaceId,
      params.workspaceRoot,
      params.command,
      params.workingDirectory,
      pid,
      pgid,
      "running",
      null,
      null,
      logPath,
      now,
      now,
      null,
      now,
      maxRuntime,
      null
    );

    // Fix finding 4: Handle asynchronous spawn error event
    child.on("error", (err: Error) => {
      const finishTime = Math.floor(Date.now() / 1000);
      try {
        this.db
          .prepare(
            `
          UPDATE durable_jobs SET status = 'failed', error = ?, ended_at = ?, last_heartbeat = ?
          WHERE id = ? AND status = 'running'
        `
          )
          .run(err.message, finishTime, finishTime, id);
      } catch {}
    });

    child.on("close", (code, sig) => {
      if (!this.db || !this.db.open) return;
      const finishTime = Math.floor(Date.now() / 1000);
      const finalStatus =
        code === 0 ? "succeeded" : sig === "SIGTERM" || sig === "SIGKILL" ? "cancelled" : "failed";
      try {
        this.db
          .prepare(
            `
          UPDATE durable_jobs SET status = ?, exit_code = ?, signal = ?, ended_at = ?, last_heartbeat = ?
          WHERE id = ? AND status = 'running'
        `
          )
          .run(finalStatus, code, sig, finishTime, finishTime, id);
      } catch {}
    });

    return this.getJob(id)!;
  }

  public cancelJob(id: string): { success: boolean; message: string; record: JobRecord | null } {
    const record = this.getJob(id);
    if (!record) {
      return { success: false, message: `Job ${id} not found`, record: null };
    }
    if (record.status !== "running") {
      return { success: false, message: `Job ${id} is already ${record.status}`, record };
    }

    if (record.pid) {
      const processHandle = {
        pid: record.pid,
        kill: (signal?: NodeJS.Signals) => {
          try { return process.kill(record.pid!, signal); }
          catch { return false; }
        },
      };
      try { terminateProcessTree(processHandle, "SIGTERM", true); } catch {}
    }

    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `
      UPDATE durable_jobs SET status = 'cancelled', signal = 'SIGTERM', ended_at = ?, last_heartbeat = ?
      WHERE id = ?
    `
      )
      .run(now, now, id);

    return { success: true, message: `Job ${id} cancelled`, record: this.getJob(id) };
  }

  public readLogs(id: string, options: LogReadOptions = {}): JobLogsResult {
    const record = this.getJob(id);
    if (!record || !existsSync(record.logPath)) {
      return { jobId: id, content: "", totalBytes: 0, hasMore: false, nextOffset: 0 };
    }

    const stat = statSync(record.logPath);
    const totalBytes = stat.size;
    const offset = Math.max(0, options.offset ?? 0);
    const maxBytes = Math.min(Math.max(1, options.maxBytes ?? 65536), 512 * 1024);

    let start = offset;
    if (options.tail && offset === 0 && totalBytes > maxBytes) {
      start = totalBytes - maxBytes;
    }

    const fd = openSync(record.logPath, "r");
    const buffer = Buffer.alloc(maxBytes);
    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buffer, 0, maxBytes, start);
    } finally {
      closeSync(fd);
    }

    const returnedBuffer = buffer.subarray(0, bytesRead);
    let text = returnedBuffer.toString("utf8");

    let actualBytesReturned = bytesRead;
    if (options.maxLines && options.maxLines > 0) {
      let linesSeen = 0;
      let newlineByte = -1;
      for (let index = 0; index < returnedBuffer.length; index += 1) {
        if (returnedBuffer[index] !== 0x0a) continue;
        linesSeen += 1;
        if (linesSeen === options.maxLines) {
          newlineByte = index;
          break;
        }
      }
      if (newlineByte >= 0) {
        actualBytesReturned = newlineByte + 1;
        text = returnedBuffer
          .subarray(0, newlineByte)
          .toString("utf8")
          .replace(/\r\n/g, "\n")
          .replace(/\r$/, "");
      }
    }

    const nextOffset = start + actualBytesReturned;
    const hasMore = nextOffset < totalBytes;

    return {
      jobId: id,
      content: text,
      totalBytes,
      hasMore,
      nextOffset,
    };
  }

  public reconcile() {
    const running = this.db.prepare("SELECT * FROM durable_jobs WHERE status = 'running'").all() as RawJobRow[];
    const now = Math.floor(Date.now() / 1000);

    for (const row of running) {
      // First check if a completion marker exists on disk
      this.checkCompletionMarker(row.id);
      const updated = this.db.prepare("SELECT status FROM durable_jobs WHERE id = ?").get(row.id) as { status: string };
      if (updated && updated.status !== "running") {
        continue;
      }

      const pid = row.pid;
      let isAlive = false;
      if (pid) {
        try {
          process.kill(pid, 0);
          isAlive = true;
        } catch {
          isAlive = false;
        }
      }

      if (!isAlive) {
        // Fix finding 1: Double-check marker again before failing
        this.checkCompletionMarker(row.id);
        const recheck = this.db.prepare("SELECT status FROM durable_jobs WHERE id = ?").get(row.id) as { status: string };
        if (recheck && recheck.status === "running") {
          this.db
            .prepare(
              `
            UPDATE durable_jobs SET status = 'failed', error = 'Process terminated without exit marker across restart', ended_at = ?, last_heartbeat = ?
            WHERE id = ?
          `
            )
            .run(now, now, row.id);
        }
      } else {
        if (row.started_at && now - row.started_at > row.max_runtime_seconds) {
          if (row.pid) {
            const processHandle = {
              pid: row.pid,
              kill: (signal?: NodeJS.Signals) => {
                try { return process.kill(row.pid!, signal); }
                catch { return false; }
              },
            };
            try { terminateProcessTree(processHandle, "SIGKILL", true); } catch {}
          }
          this.db
            .prepare(
              `
            UPDATE durable_jobs SET status = 'failed', error = 'Job exceeded maxRuntimeSeconds', ended_at = ?, last_heartbeat = ?
            WHERE id = ?
          `
            )
            .run(now, now, row.id);
        } else {
          this.db.prepare("UPDATE durable_jobs SET last_heartbeat = ? WHERE id = ?").run(now, row.id);
        }
      }
    }
  }

  public pruneCompleted(now = Math.floor(Date.now() / 1000)): number {
    const completed = this.db.prepare(`
      SELECT * FROM durable_jobs
      WHERE status != 'running'
      ORDER BY COALESCE(ended_at, created_at) DESC, created_at DESC
    `).all() as RawJobRow[];
    const cutoff = now - this.completedRetentionSeconds;
    const toDelete = completed.filter((row, index) => {
      const finishedAt = row.ended_at ?? row.created_at;
      return finishedAt <= cutoff || index >= this.maxCompletedJobs;
    });
    if (toDelete.length === 0) return 0;

    const removeRow = this.db.prepare("DELETE FROM durable_jobs WHERE id = ? AND status != 'running'");
    const transaction = this.db.transaction((rows: RawJobRow[]) => {
      for (const row of rows) removeRow.run(row.id);
    });
    transaction(toDelete);

    for (const row of toDelete) {
      for (const file of [row.log_path, this.getMarkerPath(row.id)]) {
        try { unlinkSync(file); } catch {}
      }
    }
    return toDelete.length;
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this.reconcile();
      this.pruneCompleted();
    }, 10_000);
    this.heartbeatTimer.unref();
  }

  public close() {
    clearInterval(this.heartbeatTimer);
    this.db.close();
  }
}
