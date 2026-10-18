import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { CANCELLATION_PENDING, TIMEOUT_REASON, publishJobCompletion } from "./durable-jobs.js";
import { processStartIdentity, terminateProcessTree, resolveShellCommand } from "./process-platform.js";
import { sanitizeDiagnosticError } from "./logger.js";

interface CompletionMarker {
  exitCode: number;
  signal: string | null;
  endedAt: number;
}

function writeMarker(path: string, marker: CompletionMarker): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

async function main(): Promise<void> {
  const markerPath = process.argv[2];
  let command = process.argv[3];
  const environmentPath = process.argv[4];
  if (!markerPath || command === undefined) {
    throw new Error("durable-job-runner requires marker path and command");
  }

  let environment = process.env;
  if (environmentPath) {
    let restored: NodeJS.ProcessEnv;
    try {
      const handoff = JSON.parse(readFileSync(environmentPath, "utf8")) as { command?: unknown; env?: NodeJS.ProcessEnv };
      if (typeof handoff?.command !== "string" || !handoff.env || typeof handoff.env !== "object" || Array.isArray(handoff.env)) {
        throw new Error("Invalid durable job launch specification");
      }
      command = handoff.command;
      restored = handoff.env;
    } catch {
      // JSON parser diagnostics can contain fragments of the environment.
      throw new Error("Durable job environment hand-off could not be read.");
    } finally {
      // Also remove the hand-off when JSON parsing fails. The manager
      // separately reaps files left by a runner that never reached this point.
      try { unlinkSync(environmentPath); } catch {}
    }
    environment = { ...process.env, ...restored };
  }

  const dbPath = process.argv[5];
  const id = process.argv[6];
  const db = dbPath && id ? new Database(dbPath, { fileMustExist: true }) : null;
  try {
    let deadline = Infinity;
    if (db) {
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 5000");
      const row = db.prepare("SELECT status, error, created_at, started_at, max_runtime_seconds FROM durable_jobs WHERE id = ?").get(id) as
        { status: string; error: string | null; created_at: number; started_at: number | null; max_runtime_seconds: number } | undefined;
      if (!row || !["pending", "running", "cancelling"].includes(row.status)) { return; }
      if (row.status === "cancelling" || row.error?.startsWith(CANCELLATION_PENDING) ||
        row.error?.startsWith(TIMEOUT_REASON) || row.error?.startsWith("Launch cleanup unconfirmed")) {
        const endedAt = Math.floor(Date.now() / 1000);
        publishJobCompletion(db, id, 1, null, endedAt);
        writeMarker(markerPath, { exitCode: 1, signal: null, endedAt });
        return;
      }
      const baseline = row.started_at ?? row.created_at;
      deadline = (baseline + row.max_runtime_seconds) * 1000;
      db.prepare(`UPDATE durable_jobs SET pid = ?, process_identity = ?, status = 'running',
        started_at = COALESCE(started_at, ?), error = NULL
        WHERE id = ? AND status IN ('pending', 'running') AND
        (error IS NULL OR error = 'Launch intent persisted; runner start not yet confirmed')`)
        .run(process.pid, processStartIdentity(process.pid), Math.floor(Date.now() / 1000), id);
      const claimed = db.prepare("SELECT status, error FROM durable_jobs WHERE id = ?").get(id) as {status: string; error: string | null};
      if (claimed.status !== "running" || claimed.error || Date.now() >= deadline) {
        if (Date.now() >= deadline) db.prepare(`UPDATE durable_jobs SET error = ? WHERE id = ?
          AND status IN ('pending', 'running') AND error IS NULL`).run(TIMEOUT_REASON, id);
        const endedAt = Math.floor(Date.now() / 1000);
        publishJobCompletion(db, id, 1, null, endedAt);
        writeMarker(markerPath, { exitCode: 1, signal: null, endedAt });
        return;
      }
    }

    const shell = resolveShellCommand(command, process.platform, environment);
    const child = process.platform === "win32"
      ? spawn(command, {
          cwd: process.cwd(),
          env: environment,
          stdio: "inherit",
          windowsHide: true,
          shell: shell.executable,
        })
      : spawn(shell.executable, shell.args, {
          cwd: process.cwd(),
          env: environment,
          stdio: "inherit",
          windowsHide: true,
          detached: true,
        });

    const selectStatusStmt = db && id ? db.prepare("SELECT status, error FROM durable_jobs WHERE id = ?") : null;
    const updateTimeoutStmt = db && id ? db.prepare(`UPDATE durable_jobs SET error = ? WHERE id = ? AND status IN ('pending', 'running')
      AND (error IS NULL OR error NOT LIKE ?)`) : null;

    // Own the deadline even when no Runtime manager exists. Persist intent before
    // termination, and publish only after the command process has closed.
    const supervise = () => {
      if (!selectStatusStmt || !updateTimeoutStmt || !id) return;
      const row = selectStatusStmt.get(id) as { status: string; error: string | null } | undefined;
      if (!row) return;
      const cancel = row.status === "cancelling" || row.error?.startsWith(CANCELLATION_PENDING);
      const timeout = row.error?.startsWith(TIMEOUT_REASON) || Date.now() >= deadline;
      if (timeout && !cancel) {
        updateTimeoutStmt.run(TIMEOUT_REASON, id, `${CANCELLATION_PENDING}%`);
      }
      if (cancel || timeout) terminateProcessTree(child, "SIGKILL", process.platform !== "win32");
    };
    const timer = setInterval(() => {
      try { supervise(); } catch {
        // Database contention cannot suspend a deadline indefinitely.
        if (Date.now() >= deadline) {
          try { terminateProcessTree(child, "SIGKILL", process.platform !== "win32"); } catch {}
        }
      }
    }, 100);
    let result: { code: number; signal: string | null };
    try {
      result = await new Promise<{ code: number; signal: string | null }>((resolve) => {
        // Failed spawn also emits close; a failed kill is not proof of exit.
        child.on("error", () => {});
        child.once("close", (code, signal) => resolve({ code: code ?? 1, signal: signal ?? null }));
      });
    } finally { clearInterval(timer); }
    if (db && id) {
      // A blocked event loop/SQLite wait may have crossed the deadline at exit.
      if (Date.now() >= deadline) db.prepare(`UPDATE durable_jobs SET error = ? WHERE id = ?
        AND status IN ('pending', 'running') AND error IS NULL`).run(TIMEOUT_REASON, id);
      publishJobCompletion(db, id, result.code, result.signal, Math.floor(Date.now() / 1000));
    }

    writeMarker(markerPath, {
      exitCode: result.code,
      signal: result.signal,
      endedAt: Math.floor(Date.now() / 1000),
    });
    process.exitCode = result.code;
  } finally {
    db?.close();
  }
}

void main().catch((error) => {
  const dbPath = process.argv[5];
  const id = process.argv[6];
  if (dbPath && id) {
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, { fileMustExist: true });
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 5000");
      const message = error instanceof Error ? error.message : String(error);
      const sanitized = sanitizeDiagnosticError(message);
      db.prepare(`UPDATE durable_jobs SET error = ? WHERE id = ? AND status IN ('pending', 'running', 'cancelling')
        AND (error IS NULL OR error = 'Launch intent persisted; runner start not yet confirmed')`)
        .run(sanitized, id);
      publishJobCompletion(db, id, 1, null, Math.floor(Date.now() / 1000));
    } catch {} finally { db?.close(); }
  }
  const markerPath = process.argv[2];
  if (markerPath) {
    try {
      writeMarker(markerPath, {
        exitCode: 1,
        signal: null,
        endedAt: Math.floor(Date.now() / 1000),
      });
    } catch {}
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
