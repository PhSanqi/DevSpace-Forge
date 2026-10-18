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

const FILETIME_TO_DOTNET_TICKS_OFFSET = 504911232000000000n; // 584388 days * 864000000000 ticks/day

export function fileTimeToDotNetTicks(fileTime: bigint): string {
  return (fileTime + FILETIME_TO_DOTNET_TICKS_OFFSET).toString();
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x00100000;
const PROCESS_ACCESS = PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
const WAIT_OBJECT_0 = 0;

let cachedWin32Bindings: {
  openProcess: (access: number, inherit: boolean, pid: number) => unknown;
  getProcessTimes: (hProcess: unknown, creation: Uint8Array, exit: Uint8Array, kernel: Uint8Array, user: Uint8Array) => boolean;
  closeHandle: (h: unknown) => boolean;
  waitForSingleObject: (h: unknown, ms: number) => number;
} | null = null;

function getWin32Bindings() {
  if (process.platform !== "win32") return null;
  if (cachedWin32Bindings) return cachedWin32Bindings;
  try {
    const koffi = require("koffi");
    const kernel32 = koffi.load("kernel32.dll");
    const openProcess = kernel32.func("void * __stdcall OpenProcess(uint32_t desiredAccess, bool inheritHandle, uint32_t processId)");
    const getProcessTimes = kernel32.func("bool __stdcall GetProcessTimes(void *hProcess, void *lpCreationTime, void *lpExitTime, void *lpKernelTime, void *lpUserTime)");
    const closeHandle = kernel32.func("bool __stdcall CloseHandle(void *handle)");
    const waitForSingleObject = kernel32.func("uint32_t __stdcall WaitForSingleObject(void *h, uint32_t ms)");
    cachedWin32Bindings = { openProcess, getProcessTimes, closeHandle, waitForSingleObject };
    return cachedWin32Bindings;
  } catch {
    return null;
  }
}

let customIdentityProvider: ((pid: number) => string | null) | null = null;

export function setProcessIdentityProviderForTests(
  provider: ((pid: number) => string | null) | null,
): void {
  customIdentityProvider = provider;
}

// A PID alone is not durable ownership: it may have been recycled after restart.
export function processStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (customIdentityProvider) {
    try {
      return customIdentityProvider(pid);
    } catch {
      return null;
    }
  }
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || fields[0] === "X") return null;
      return fields[19] ? `linux:${fields[19]}` : null;
    }
    if (process.platform === "win32") {
      try {
        const bindings = getWin32Bindings();
        if (bindings) {
          const handle = bindings.openProcess(PROCESS_ACCESS, false, pid);
          if (handle) {
            try {
              if (bindings.waitForSingleObject(handle, 0) === WAIT_OBJECT_0) {
                return null;
              }
              const creation = Buffer.alloc(8);
              const exit = Buffer.alloc(8);
              const kernel = Buffer.alloc(8);
              const user = Buffer.alloc(8);
              if (bindings.getProcessTimes(handle, creation, exit, kernel, user)) {
                const creationTime = creation.readBigUInt64LE(0);
                if (creationTime > 0n) {
                  return `windows:${fileTimeToDotNetTicks(creationTime)}`;
                }
              }
              return null;
            } finally {
              bindings.closeHandle(handle);
            }
          }
          return null;
        }
      } catch {
        // Fall through to PowerShell fallback only when koffi is unavailable/throws
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

const syncWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

export function waitForOwnedProcessExit(pid: number, identity: string | null, timeoutMs: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;

  if (process.platform === "win32" && !customIdentityProvider) {
    try {
      const bindings = getWin32Bindings();
      if (bindings) {
        const handle = bindings.openProcess(PROCESS_ACCESS, false, pid);
        if (!handle) {
          return true;
        }
        try {
          const creation = Buffer.alloc(8);
          const exit = Buffer.alloc(8);
          const kernel = Buffer.alloc(8);
          const user = Buffer.alloc(8);
          let currentIdentity: string | null = null;
          if (bindings.getProcessTimes(handle, creation, exit, kernel, user)) {
            const creationTime = creation.readBigUInt64LE(0);
            if (creationTime > 0n) {
              currentIdentity = `windows:${fileTimeToDotNetTicks(creationTime)}`;
            }
          }
          if (identity && currentIdentity !== identity) {
            return true;
          }
          const timeout = Math.min(0xffffffff, Math.max(0, Math.floor(timeoutMs)));
          return bindings.waitForSingleObject(handle, timeout) === WAIT_OBJECT_0;
        } finally {
          bindings.closeHandle(handle);
        }
      }
    } catch {
      // Koffi unavailable/threw, fall through to poll path
    }
  }

  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    if (ownedProcessState(pid, identity) !== "active") {
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    Atomics.wait(syncWaitBuffer, 0, 0, Math.min(25, remaining));
  }
  return ownedProcessState(pid, identity) !== "active";
}

