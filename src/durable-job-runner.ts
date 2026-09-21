import { renameSync, writeFileSync } from "node:fs";
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
  const command = process.argv[3];
  if (!markerPath || command === undefined) {
    throw new Error("durable-job-runner requires marker path and command");
  }

  const shell = resolveShellCommand(command, process.platform, process.env);
  const child = process.platform === "win32"
    ? spawn(command, {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
        windowsHide: true,
        shell: shell.executable,
      })
    : spawn(shell.executable, shell.args, {
        cwd: process.cwd(),
        env: process.env,
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
