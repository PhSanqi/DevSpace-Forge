import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolveShellCommand } from "./process-platform.js";

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
      });

  const result = await new Promise<{ code: number; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code: code ?? 1, signal: signal ?? null });
    });
  });

  writeMarker(markerPath, {
    exitCode: result.code,
    signal: result.signal,
    endedAt: Math.floor(Date.now() / 1000),
  });
  process.exitCode = result.code;
}

void main().catch((error) => {
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
