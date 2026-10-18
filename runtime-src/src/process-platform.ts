import { basename } from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface ShellCommand {
  executable: string;
  args: string[];
}

export interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

interface ProcessTreeRuntime {
  platform?: NodeJS.Platform;
  killGroup(pid: number, signal: NodeJS.Signals): void;
  killWindowsTree(pid: number): boolean;
}

const defaultProcessTreeRuntime: ProcessTreeRuntime = {
  get platform() { return process.platform; },
  killGroup: (pid, signal) => process.kill(-pid, signal),
  killWindowsTree: (pid) => {
    const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  },
};

const LOGIN_SHELLS = new Set(["bash", "ksh", "zsh"]);
const POSIX_SHELLS = new Set(["ash", "dash", "sh"]);

export function resolveShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ShellCommand {
  if (platform === "win32") {
    return {
      executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }

  const configuredShell = environment.SHELL;
  const shellName = configuredShell ? basename(configuredShell) : "";
  if (configuredShell && LOGIN_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-lc", command] };
  }
  if (configuredShell && POSIX_SHELLS.has(shellName)) {
    return { executable: configuredShell, args: ["-c", command] };
  }

  return { executable: "/bin/sh", args: ["-c", command] };
}

export function terminateProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals,
  detached: boolean,
  runtime: ProcessTreeRuntime = defaultProcessTreeRuntime,
  platform: NodeJS.Platform = runtime.platform ?? process.platform,
): void {
  if (platform === "win32" && child.pid) {
    if (runtime.killWindowsTree(child.pid)) return;
  } else if (detached && child.pid) {
    try {
      runtime.killGroup(child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }

  child.kill(signal);
}

let cachedWin32Bindings: {
  openProcess: (access: number, inherit: boolean, pid: number) => unknown;
  getProcessTimes: (hProcess: unknown, creation: bigint[], exit: bigint[], kernel: bigint[], user: bigint[]) => boolean;
  closeHandle: (h: unknown) => boolean;
} | null = null;

function getWin32Bindings() {
  if (process.platform !== "win32") return null;
  if (cachedWin32Bindings) return cachedWin32Bindings;
  try {
    const koffi = require("koffi");
    const kernel32 = koffi.load("kernel32.dll");
    const openProcess = kernel32.func("void * __stdcall OpenProcess(uint32_t desiredAccess, bool inheritHandle, uint32_t processId)");
    const getProcessTimes = kernel32.func("bool __stdcall GetProcessTimes(void *hProcess, _Out_ uint64_t *lpCreationTime, _Out_ uint64_t *lpExitTime, _Out_ uint64_t *lpKernelTime, _Out_ uint64_t *lpUserTime)");
    const closeHandle = kernel32.func("bool __stdcall CloseHandle(void *handle)");
    cachedWin32Bindings = { openProcess, getProcessTimes, closeHandle };
    return cachedWin32Bindings;
  } catch {
    return null;
  }
}

// A PID alone is not durable ownership: it may have been recycled after restart.
export function processStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || fields[0] === "X") return null;
      return fields[19] ? `linux:${fields[19]}` : null;
    }
    if (process.platform === "win32") {
      const bindings = getWin32Bindings();
      if (bindings) {
        const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        const handle = bindings.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle) {
          try {
            const creation = [0n];
            const exit = [0n];
            const kernel = [0n];
            const user = [0n];
            if (bindings.getProcessTimes(handle, creation, exit, kernel, user) && creation[0] > 0n) {
              const ticks = (creation[0] + 504911232000000000n).toString();
              return `windows:${ticks}`;
            }
          } finally {
            bindings.closeHandle(handle);
          }
        }
      }
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; (Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks.ToString()`],
      { encoding: "utf8", windowsHide: true, timeout: 5_000 });
      const ticks = result.stdout?.trim();
      return result.status === 0 && /^\d+$/.test(ticks) ? `windows:${ticks}` : null;
    }
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2_000 });
    return result.status === 0 && result.stdout.trim() ? `ps:${result.stdout.trim()}` : null;
  } catch { return null; }
}

export function ownedProcessState(pid: number | null, identity: string | null): "active" | "inactive" | "unknown" {
  if (!pid) return "unknown";
  const current = processStartIdentity(pid);
  if (current && identity) return current === identity ? "active" : "inactive";
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (/^[ZX] /.test(stat.slice(stat.lastIndexOf(")") + 2))) return "inactive";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "inactive";
  }
  return "unknown";
}
