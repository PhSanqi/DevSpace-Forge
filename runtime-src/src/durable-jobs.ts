import { spawn, spawnSync } from "node:child_process";
import {
  openSync,
  closeSync,
  existsSync,
  mkdirSync,
  rmdirSync,
  statSync,
  readSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { terminateProcessTree, processStartIdentity, ownedProcessState } from "./process-platform.js";

export interface JobRecord {
  id: string;
  workspaceId: string;
  workspaceRoot: string;
  command: string;
  workingDirectory: string;
  pid: number | null;
  pgid: number | null;
  processIdentity: string | null;
  status: "pending" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
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
  process_identity: string | null;
  status: "pending" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
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

// Require the exact generated handle; $ alone also permits a trailing newline.
export const DURABLE_JOB_ID_PATTERN = /^job_[0-9a-f]{16}(?![\s\S])/;

const DEFAULT_COMPLETED_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_MAX_COMPLETED_JOBS = 1_000;

export function durableJobSystemdUnitName(id: string): string {
  return `devspace-job-${id}.service`;
}

let systemdUserIsolationAvailable: boolean | undefined;
export function canUseSystemdUserJobIsolation(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS === "1") return false;
  if (systemdUserIsolationAvailable !== undefined) return systemdUserIsolationAvailable;
  const control = spawnSync("systemctl", ["--user", "show-environment"], { encoding: "utf8", timeout: 2_000, windowsHide: true });
  const runner = spawnSync("systemd-run", ["--user", "--version"], { encoding: "utf8", timeout: 2_000, windowsHide: true });
  systemdUserIsolationAvailable = control.status === 0 && runner.status === 0;
  return systemdUserIsolationAvailable;
}

function systemdJobUnitState(id: string): "active" | "inactive" | "unknown" {
  if (process.platform !== "linux") return "inactive";
  const result = spawnSync("systemctl", ["--user", "is-active", durableJobSystemdUnitName(id)], { encoding: "utf8", timeout: 2_000, windowsHide: true });
  const state = result.stdout?.trim();
  if (!result.error && (result.status === 0 || ["activating", "deactivating", "reloading", "refreshing"].includes(state))) return "active";
  if (!result.error && ((result.status === 3 || result.status === 4) && ["inactive", "failed", "unknown"].includes(state))) return "inactive";
  // A disconnected user bus or a timed-out status query is UNKNOWN, not
  // evidence that the process has stopped. Preserve the running record.
  return "unknown";
}

function stopSystemdJobUnit(id: string): boolean {
  if (process.platform !== "linux") return false;
  const result = spawnSync("systemctl", ["--user", "stop", durableJobSystemdUnitName(id)], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  return result.status === 0;
}

export const CANCELLATION_PENDING = "Cancellation requested; process exit not yet confirmed";
export const TIMEOUT_REASON = "Job exceeded maxRuntimeSeconds";
const NON_TERMINAL = "('pending', 'running', 'cancelling')";

// One guarded UPDATE makes earlier persisted cancellation/timeout intent win
// over a late successful exit, including completion-marker recovery.
export function publishJobCompletion(db: Database.Database, id: string, code: number, signal: string | null, endedAt: number): void {
  db.prepare(`UPDATE durable_jobs SET status = CASE
    WHEN status = 'cancelling' OR error LIKE ? THEN 'cancelled'
    WHEN error LIKE ? THEN 'failed'
    WHEN ? = 0 THEN 'succeeded' ELSE 'failed' END,
    exit_code = ?, signal = ?, ended_at = ?, last_heartbeat = ?
    WHERE id = ? AND status IN ${NON_TERMINAL}`)
    .run(`${CANCELLATION_PENDING}%`, `${TIMEOUT_REASON}%`, code, code, signal, endedAt, endedAt, id);
}

function trackedJobState(row: RawJobRow): "active" | "inactive" | "unknown" {
  // The named unit owns the Linux cgroup; an unrelated PID cannot override it.
  if (process.platform === "linux" && canUseSystemdUserJobIsolation()) return systemdJobUnitState(row.id);
  return ownedProcessState(row.pid, row.process_identity);
}

function requestTrackedJobStop(row: RawJobRow, signal: NodeJS.Signals): void {
  if (process.platform === "linux" && canUseSystemdUserJobIsolation()) {
    stopSystemdJobUnit(row.id);
    return;
  }
  if (row.pid && ownedProcessState(row.pid, row.process_identity) === "active") {
    const pid = row.pid;
    try { terminateProcessTree({ pid, kill: (requested) => {
      if (ownedProcessState(pid, row.process_identity) !== "active") return false;
      try { return process.kill(pid, requested); } catch { return false; }
    } }, signal, true); } catch {}
  }
}

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
    this.db.pragma("busy_timeout = 5000");
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
    const columns = this.db.prepare("PRAGMA table_info(durable_jobs)").all() as { name: string }[];
    if (!columns.some(column => column.name === "process_identity")) {
      this.db.exec("ALTER TABLE durable_jobs ADD COLUMN process_identity TEXT");
    }
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
      processIdentity: row.process_identity,
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
    if (!DURABLE_JOB_ID_PATTERN.test(id)) return null;
    const query = this.db.prepare("SELECT * FROM durable_jobs WHERE id = ?");
    const row = query.get(id) as RawJobRow | undefined;
    if (!row) return null;
    this.checkCompletionMarker(id);
    return this.rowToRecord(query.get(id) as RawJobRow);
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

  private reapOrphanLaunchSpecs(): void {
    if (process.platform !== "linux") return;
    // Launch and hand-off cleanup share the existing launch/switch gate.
    if (existsSync(join(this.jobsDir, "..", ".runtime-switch-gate"))) return;
    const cutoffMs = Date.now() - 60_000;
    for (const name of readdirSync(this.metadataDir)) {
      const match = /^(job_[0-9a-f]{16})\.env\.json$/.exec(name);
      if (!match) continue;
      const path = join(this.metadataDir, name);
      try {
        if (statSync(path).mtimeMs > cutoffMs) continue;
        const row = this.db.prepare("SELECT status FROM durable_jobs WHERE id = ?").get(match[1]) as { status: string } | undefined;
        if ((row && ["pending", "running", "cancelling"].includes(row.status)) || systemdJobUnitState(match[1]) !== "inactive") continue;
        unlinkSync(path);
      } catch {
        // An unknown unit state or filesystem error is not permission to
        // remove a potentially live job's launch credentials.
      }
    }
  }

  private checkCompletionMarker(id: string): void {
    if (!DURABLE_JOB_ID_PATTERN.test(id)) return;
    const markerPath = this.getMarkerPath(id);
    if (existsSync(markerPath)) {
      try {
        const raw = readFileSync(markerPath, "utf8").trim();
        const parsed = JSON.parse(raw) as { exitCode: number; signal: string | null; endedAt: number };
        if (!Number.isInteger(parsed.exitCode) || !Number.isFinite(parsed.endedAt) ||
          !(parsed.signal === null || typeof parsed.signal === "string")) return;
        publishJobCompletion(this.db, id, parsed.exitCode, parsed.signal, parsed.endedAt);
        try { unlinkSync(join(this.metadataDir, `${id}.env.json`)); } catch {}
      } catch {}
    }
  }

  public startJob(params: StartJobParams): JobRecord {
    const id = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = Math.floor(Date.now() / 1000);
    const maxRuntime = params.maxRuntimeSeconds && params.maxRuntimeSeconds > 0 ? params.maxRuntimeSeconds : 86400;
    const logPath = join(this.logsDir, `${id}.log`);
    const markerPath = this.getMarkerPath(id);
    const environmentPath = join(this.metadataDir, `${id}.env.json`);
    const insert = (status: string, reason: string) => this.db.prepare(`INSERT INTO durable_jobs
      (id, workspace_id, workspace_root, command, working_directory, status, log_path,
       created_at, last_heartbeat, max_runtime_seconds, error, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, params.workspaceId, params.workspaceRoot, params.command, params.workingDirectory,
        status, logPath, now, now, maxRuntime, reason, status === "failed" ? now : null);
    const gate = join(this.jobsDir, "..", ".runtime-switch-gate");
    try { mkdirSync(gate); }
    catch {
      insert("failed", "Job start blocked by the runtime switch gate.");
      return this.getJob(id)!;
    }
    try {
      // No launch or hand-off is allowed until this blocking row is durable.
      insert("pending", "Launch intent persisted; runner start not yet confirmed");
      let attempted = false;
      let pid: number | null = null;
      let identity: string | null = null;
      try {
        if (process.platform === "linux" && !canUseSystemdUserJobIsolation()) {
          throw new Error("Linux user-systemd durable job isolation is unavailable.");
        }
        const compiled = fileURLToPath(new URL("./durable-job-runner.js", import.meta.url));
        const source = fileURLToPath(new URL("./durable-job-runner.ts", import.meta.url));
        const runnerArgs = existsSync(compiled) ? [compiled] : ["--import", "tsx", source];
        writeFileSync(environmentPath, JSON.stringify({ command: params.command,
          env: { ...process.env, ...params.env, DEVSPACE_JOB_ID: id } }), { mode: 0o600, flag: "wx" });
        runnerArgs.push(markerPath, "", environmentPath, join(this.jobsDir, "jobs.sqlite"), id);
        if (process.platform === "linux") {
          attempted = true;
          const unit = durableJobSystemdUnitName(id);
          const result = spawnSync("systemd-run", ["--user", `--unit=${unit}`, "--collect", "--property=Type=exec",
            `--property=StandardOutput=append:${logPath}`, `--property=StandardError=append:${logPath}`,
            `--working-directory=${params.workingDirectory}`, process.execPath, ...runnerArgs],
          { encoding: "utf8", timeout: 5_000, windowsHide: true });
          if (result.status !== 0 || result.error) throw new Error("User-systemd durable job launch failed.");
          const shown = spawnSync("systemctl", ["--user", "show", unit, "-p", "MainPID", "--value"],
            { encoding: "utf8", timeout: 2_000, windowsHide: true });
          const candidate = Number.parseInt(shown.stdout?.trim(), 10);
          pid = Number.isInteger(candidate) && candidate > 0 ? candidate : null;
        } else {
          const outFd = openSync(logPath, "a", 0o600);
          try {
            const child = spawn(process.execPath, runnerArgs, { cwd: params.workingDirectory,
              detached: true, stdio: ["ignore", outFd, outFd], windowsHide: true });
            pid = child.pid ?? null;
            attempted = pid !== null;
            // Spawn errors are recovered from the persisted pending intent.
            child.on("error", () => {});
            child.unref();
            if (!pid) throw new Error("Durable job runner could not start.");
          } finally { closeSync(outFd); }
        }
        identity = pid ? processStartIdentity(pid) : null;
        // Runner may already have completed. Never overwrite its terminal row.
        this.db.prepare(`UPDATE durable_jobs SET pid = ?, pgid = ?, process_identity = ?,
          status = 'running', started_at = COALESCE(started_at, ?), error = NULL
          WHERE id = ? AND status = 'pending'
          AND error = 'Launch intent persisted; runner start not yet confirmed'`)
          .run(pid, process.platform === "win32" || process.platform === "linux" ? null : pid, identity, now, id);
      } catch (error) {
        if (attempted) requestTrackedJobStop({ id, pid, process_identity: identity } as RawJobRow, "SIGKILL");
        const stopped = !attempted || trackedJobState({ id, pid, process_identity: identity } as RawJobRow) === "inactive";
        const reason = error instanceof Error ? error.message : "Durable job launch failed";
        this.db.prepare(`UPDATE durable_jobs SET status = CASE
          WHEN ? = 1 THEN CASE WHEN status = 'cancelling' OR error LIKE ? THEN 'cancelled' ELSE 'failed' END
          WHEN status = 'cancelling' THEN status ELSE 'pending' END,
          error = CASE WHEN error LIKE ? OR error LIKE ? THEN error ELSE ? END, ended_at = ?
          WHERE id = ? AND status IN ${NON_TERMINAL}`)
          .run(stopped ? 1 : 0, `${CANCELLATION_PENDING}%`, `${CANCELLATION_PENDING}%`, `${TIMEOUT_REASON}%`,
            stopped ? reason : "Launch cleanup unconfirmed; reconciliation must retry", stopped ? now : null, id);
        if (stopped) try { unlinkSync(environmentPath); } catch {}
      }
      return this.getJob(id)!;
    } finally {
      try { rmdirSync(gate); } catch {}
    }
  }

  public cancelJob(id: string): { success: boolean; message: string; record: JobRecord | null } {
    const record = this.getJob(id);
    if (!record) return { success: false, message: `Job ${id} not found`, record: null };
    if (!["pending", "running", "cancelling"].includes(record.status)) {
      return { success: false, message: `Job ${id} is already ${record.status}`, record };
    }
    this.db.prepare(`UPDATE durable_jobs SET error = ? WHERE id = ? AND status IN ${NON_TERMINAL}`)
      .run(CANCELLATION_PENDING, id);
    const row = this.db.prepare("SELECT * FROM durable_jobs WHERE id = ?").get(id) as RawJobRow;
    requestTrackedJobStop(row, "SIGTERM");
    if (trackedJobState(row) !== "inactive") {
      return { success: false, message: `Job ${id} exit/identity unconfirmed; cancellation will retry`, record: this.getJob(id) };
    }
    publishJobCompletion(this.db, id, 1, "SIGTERM", Math.floor(Date.now() / 1000));
    try { unlinkSync(join(this.metadataDir, `${id}.env.json`)); } catch {}
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
    // A live starter owns pending launch decisions while holding this gate.
    if (existsSync(join(this.jobsDir, "..", ".runtime-switch-gate"))) return;
    const rows = this.db.prepare(`SELECT * FROM durable_jobs WHERE status IN ${NON_TERMINAL}`).all() as RawJobRow[];
    const now = Math.floor(Date.now() / 1000);
    for (const row of rows) {
      this.checkCompletionMarker(row.id);
      const current = this.db.prepare("SELECT * FROM durable_jobs WHERE id = ?").get(row.id) as RawJobRow;
      if (!["pending", "running", "cancelling"].includes(current.status)) continue;
      const cancellation = current.status === "cancelling" || current.error?.startsWith(CANCELLATION_PENDING);
      const startBaseline = current.started_at ?? current.created_at;
      const timedOut = current.error?.startsWith(TIMEOUT_REASON) ||
        Boolean(startBaseline && now - startBaseline >= current.max_runtime_seconds);
      const launchUnconfirmed = current.status === "pending";
      if (timedOut && !cancellation) {
        this.db.prepare(`UPDATE durable_jobs SET error = ? WHERE id = ? AND status IN ${NON_TERMINAL}
          AND (error IS NULL OR error NOT LIKE ?)`)
          .run(TIMEOUT_REASON, current.id, `${CANCELLATION_PENDING}%`);
      }
      if (cancellation || timedOut || launchUnconfirmed) requestTrackedJobStop(current, cancellation ? "SIGTERM" : "SIGKILL");
      const state = trackedJobState(current);
      if (state === "inactive") {
        this.checkCompletionMarker(current.id);
        this.db.prepare(`UPDATE durable_jobs SET status = CASE
          WHEN status = 'cancelling' OR error LIKE ? THEN 'cancelled' ELSE 'failed' END,
          error = CASE WHEN error LIKE ? OR error LIKE ? THEN error ELSE ? END,
          ended_at = ?, last_heartbeat = ? WHERE id = ? AND status IN ${NON_TERMINAL}`)
          .run(`${CANCELLATION_PENDING}%`, `${CANCELLATION_PENDING}%`, `${TIMEOUT_REASON}%`,
            "Process terminated without exit marker across restart", now, now, current.id);
        try { unlinkSync(join(this.metadataDir, `${current.id}.env.json`)); } catch {}
      } else {
        this.db.prepare(`UPDATE durable_jobs SET last_heartbeat = ?, error = CASE
          WHEN error IS NULL AND ? = 'unknown' THEN 'Process identity/exit unconfirmed; reconciliation will retry'
          ELSE error END WHERE id = ? AND status IN ${NON_TERMINAL}`).run(now, state, current.id);
      }
    }
    this.reapOrphanLaunchSpecs();
  }

  public pruneCompleted(now = Math.floor(Date.now() / 1000)): number {
    const completed = this.db.prepare(`
      SELECT * FROM durable_jobs
      WHERE status IN ('succeeded', 'failed', 'cancelled')
      ORDER BY COALESCE(ended_at, created_at) DESC, created_at DESC
    `).all() as RawJobRow[];
    const cutoff = now - this.completedRetentionSeconds;
    const toDelete = completed.filter((row, index) => {
      const finishedAt = row.ended_at ?? row.created_at;
      return finishedAt <= cutoff || index >= this.maxCompletedJobs;
    });
    if (toDelete.length === 0) return 0;

    const removeRow = this.db.prepare("DELETE FROM durable_jobs WHERE id = ? AND status IN ('succeeded', 'failed', 'cancelled')");
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
