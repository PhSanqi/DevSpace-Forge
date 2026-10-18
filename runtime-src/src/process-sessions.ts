import { spawn } from "node:child_process";
import { resolveProjectEnvironment } from "./runtime-env.js";
import { ProcessRunLogger } from "./compact-runtime/process-run-store.js";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";

export const DEFAULT_EXEC_YIELD_MS = 3_000;
const DEFAULT_INTERACTIVE_YIELD_MS = 250;
const DEFAULT_POLL_YIELD_MS = 5_000;
export const MAX_PROCESS_YIELD_MS = 12_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_BUFFER_CHARACTERS = 1_000_000;
const COMPLETED_SESSION_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export interface StartCommandInput {
  workspaceId: string;
  command: string;
  cwd: string;
  workspaceRoot?: string;
  tty?: boolean;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface WriteStdinInput {
  workspaceId: string;
  sessionId: number;
  chars?: string;
  columns?: number;
  rows?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface ProcessSnapshot {
  sessionId?: number;
  output: string;
  outputTruncated: boolean;
  running: boolean;
  exitCode?: number;
  signal?: string;
  wallTimeMs: number;
  runId?: string;
  command?: string;
  outputBytes?: number;
  outputLines?: number;
  logError?: string;
}

interface ManagedProcess {
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void;
  resize?(columns: number, rows: number): void;
}

interface PtyHandle {
  pid: number;
  write(data: string): void;
  kill(signal?: string): void;
  resize(columns: number, rows: number): void;
  pause(): void;
  resume(): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal: number }) => void): unknown;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      name: string;
      cols: number;
      rows: number;
    },
  ): PtyHandle;
}

const PTY_MODULE_CANDIDATES = [
  "node-pty",
  "@homebridge/node-pty-prebuilt-multiarch",
] as const;

function normalizePtyModule(value: unknown): PtyModule | undefined {
  if (!value || typeof value !== "object") return undefined;
  const direct = value as { spawn?: unknown; default?: unknown };
  if (typeof direct.spawn === "function") return direct as unknown as PtyModule;
  if (!direct.default || typeof direct.default !== "object") return undefined;
  const fallback = direct.default as { spawn?: unknown };
  return typeof fallback.spawn === "function"
    ? fallback as unknown as PtyModule
    : undefined;
}

async function loadPtyModule(): Promise<PtyModule> {
  const failures: string[] = [];
  for (const specifier of PTY_MODULE_CANDIDATES) {
    try {
      // Keep this import dynamic. The fallback is an optional Linux runtime
      // dependency and should not become a hard type/build dependency.
      const imported: unknown = await import(specifier);
      const pty = normalizePtyModule(imported);
      if (pty) return pty;
      failures.push(`${specifier}: module does not expose spawn()`);
    } catch (error) {
      failures.push(
        `${specifier}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(
    `PTY support is unavailable. Tried ${PTY_MODULE_CANDIDATES.join(", ")}. ${failures.join(" | ")}`,
  );
}

interface ProcessSession {
  id: number;
  workspaceId: string;
  process?: ManagedProcess;
  startedAt: number;
  columns: number;
  rows: number;
  buffer: HeadTailBuffer;
  running: boolean;
  finishing?: boolean;
  exitCode?: number;
  signal?: string;
  exitPromise: Promise<void>;
  resolveExit: () => void;
  cleanupTimer?: NodeJS.Timeout;
  lifetimeTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  logger?: ProcessRunLogger;
  flushPromise?: Promise<unknown>;
  drainPromise?: Promise<void>;
  pauseGeneration?: number;
}

interface ProcessSessionManagerOptions {
  maxBufferCharacters?: number;
  completedSessionTtlMs?: number;
  runRoot?: string;
  maxSessions?: number;
  maxRuntimeMs?: number;
  idleTimeoutMs?: number;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Duration and output limits must be non-negative.");
  }
  return Math.min(Math.floor(value), maximum);
}

function terminalSize(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Terminal dimensions must be integers between 1 and 1000.");
  }
  return value;
}

function processEnvironment(input?: {
  workspaceId?: string;
  workspaceRoot?: string;
}): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(resolveProjectEnvironment(input?.workspaceRoot)).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    NO_COLOR: "1",
    TERM: "dumb",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    CODEX_CI: "1",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    ...(input?.workspaceId ? { DEVSPACE_WORKSPACE_ID: input.workspaceId } : {}),
    ...(input?.workspaceRoot ? { DEVSPACE_WORKSPACE_ROOT: input.workspaceRoot } : {}),
  };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function sliceCodePoints(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

function takeHead(value: string, count: number): string {
  if (count <= 0) return "";
  return sliceCodePoints(value, 0, count);
}

function takeTail(value: string, count: number): string {
  if (count <= 0) return "";
  const characters = Array.from(value);
  return characters.slice(Math.max(0, characters.length - count)).join("");
}

function splitBudget(maxCharacters: number): { head: number; tail: number } {
  return {
    head: Math.ceil(maxCharacters / 2),
    tail: Math.floor(maxCharacters / 2),
  };
}

function formatHeadTail(head: string, tail: string, omittedCharacters: number): string {
  if (omittedCharacters <= 0) return head + tail;
  return `${head}\n... output truncated (${omittedCharacters} characters omitted) ...\n${tail}`;
}

export class HeadTailBuffer {
  private head = "";
  private tail = "";
  private totalCharacters = 0;

  constructor(private readonly maxCharacters: number) {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Head/tail buffer limit must be a positive integer.");
    }
  }

  append(output: string): void {
    if (!output) return;

    const previousTotal = this.totalCharacters;
    this.totalCharacters += codePointLength(output);

    if (this.totalCharacters <= this.maxCharacters) {
      this.head += output;
      return;
    }

    const budget = splitBudget(this.maxCharacters);
    if (previousTotal <= this.maxCharacters) {
      const fullOutput = this.head + output;
      this.head = takeHead(fullOutput, budget.head);
      this.tail = takeTail(fullOutput, budget.tail);
      return;
    }

    this.tail = takeTail(this.tail + output, budget.tail);
  }

  hasOutput(): boolean {
    return this.totalCharacters > 0;
  }

  drain(maxCharacters: number): { output: string; truncated: boolean } {
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1) {
      throw new Error("Output limit must be a positive integer.");
    }

    const omittedByBuffer = Math.max(
      0,
      this.totalCharacters - codePointLength(this.head) - codePointLength(this.tail),
    );
    const retained = formatHeadTail(this.head, this.tail, omittedByBuffer);
    const output = truncateOutput(retained, maxCharacters);
    const truncated = omittedByBuffer > 0 || output.truncated;

    this.head = "";
    this.tail = "";
    this.totalCharacters = 0;

    return { output: output.output, truncated };
  }
}

function truncateOutput(output: string, maxCharacters: number): { output: string; truncated: boolean } {
  const outputCharacters = codePointLength(output);
  if (outputCharacters <= maxCharacters) return { output, truncated: false };

  const marker = "\n... output truncated ...\n";
  const markerCharacters = codePointLength(marker);
  const available = Math.max(0, maxCharacters - markerCharacters);
  const budget = splitBudget(available);
  return {
    output: takeHead(output, budget.head) + marker + takeTail(output, budget.tail),
    truncated: true,
  };
}

export class ProcessSessionManager {
  private readonly sessions = new Map<number, ProcessSession>();
  private readonly maxBufferCharacters: number;
  private readonly completedSessionTtlMs: number;
  private nextSessionId = 1;
  private readonly maxSessions: number;
  private readonly maxRuntimeMs: number;
  private readonly idleTimeoutMs: number;
  readonly runRoot?: string;

  constructor(options: ProcessSessionManagerOptions = {}) {
    this.maxBufferCharacters = options.maxBufferCharacters ?? DEFAULT_BUFFER_CHARACTERS;
    this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;
    this.runRoot = options.runRoot;
    this.maxSessions = options.maxSessions ?? 10;
    this.maxRuntimeMs = options.maxRuntimeMs ?? 8 * 60 * 60_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 2 * 60 * 60_000;
    for (const value of [this.maxSessions, this.maxRuntimeMs, this.idleTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Process session limits must be positive integers.");
    }
  }

  async start(input: StartCommandInput): Promise<ProcessSnapshot> {
    if (this.sessions.size >= this.maxSessions) {
      for (const session of this.sessions.values()) {
        if (!session.running) this.removeSession(session.id);
      }
      if (this.sessions.size >= this.maxSessions) {
        throw new Error(`Process session limit of ${this.maxSessions} running sessions reached; wait for a session to exit or terminate one to free a slot.`);
      }
    }
    const session = this.createSession(input);
    this.sessions.set(session.id, session);
    try {
      if (this.runRoot) session.logger = await ProcessRunLogger.create({
        command: input.command, cwd: input.cwd,
        workspaceRoot: input.workspaceRoot ?? input.cwd, root: this.runRoot,
      });
      if (!this.sessions.has(session.id)) throw new Error("Process session manager shut down during launch.");
      if (input.tty && process.platform !== "win32") await this.startPty(session, input);
      else this.startPipe(session, input);
    } catch (error) {
      this.sessions.delete(session.id);
      if (session.logger) void session.logger.finish({ exitCode: 1 });
      throw error;
    }

    if (session.running) {
      session.lifetimeTimer = setTimeout(() => session.process?.kill("SIGKILL"), this.maxRuntimeMs);
      session.lifetimeTimer.unref();
      this.resetIdleTimer(session);
    }
    const yieldTimeMs = boundedInteger(input.yieldTimeMs, DEFAULT_EXEC_YIELD_MS, MAX_PROCESS_YIELD_MS);
    await this.waitForExit(session, yieldTimeMs);

    const snapshot = await this.consume(session, input.maxOutputTokens);
    if (!snapshot.running) this.removeSession(session.id);
    return snapshot;
  }

  async write(input: WriteStdinInput): Promise<ProcessSnapshot> {
    const session = this.getOwnedSession(input.workspaceId, input.sessionId);
    if (!session.running || session.finishing) {
      const snapshot = await this.consume(session, input.maxOutputTokens);
      this.removeSession(session.id);
      return snapshot;
    }
    this.resetIdleTimer(session);
    const chars = input.chars ?? "";
    const interactionRequested =
      chars.length > 0 || input.columns !== undefined || input.rows !== undefined;

    if (input.columns !== undefined || input.rows !== undefined) {
      session.columns = terminalSize(input.columns, session.columns);
      session.rows = terminalSize(input.rows, session.rows);
      if (!session.process?.resize) {
        throw new Error(`Process session ${session.id} is not a PTY and cannot be resized.`);
      }
      session.process.resize(session.columns, session.rows);
    }

    const interruptRequested = chars.includes("\u0003") && session.running;
    if (interruptRequested) {
      session.process?.kill("SIGINT");
    }
    const writableChars = chars.replaceAll("\u0003", "");
    if (writableChars && session.running) session.process?.write(writableChars);

    if ((interactionRequested || !session.buffer.hasOutput()) && session.running) {
      const fallback = interactionRequested ? DEFAULT_INTERACTIVE_YIELD_MS : DEFAULT_POLL_YIELD_MS;
      const yieldTimeMs = boundedInteger(input.yieldTimeMs, fallback, MAX_PROCESS_YIELD_MS);
      await this.waitForExit(session, yieldTimeMs);
    }

    const snapshot = await this.consume(session, input.maxOutputTokens);
    if (!snapshot.running) this.removeSession(session.id);
    return snapshot;
  }

  terminate(workspaceId: string, sessionId: number): void {
    const session = this.getOwnedSession(workspaceId, sessionId);
    if (session.running) session.process?.kill("SIGTERM");
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
      if (session.lifetimeTimer) clearTimeout(session.lifetimeTimer);
      if (session.idleTimer) clearTimeout(session.idleTimer);
      if (session.running) session.process?.kill("SIGTERM");
    }
    this.sessions.clear();
  }

  private resetIdleTimer(session: ProcessSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (!session.running || session.finishing) return;
    session.idleTimer = setTimeout(() => session.process?.kill("SIGKILL"), this.idleTimeoutMs);
    session.idleTimer.unref();
  }

  private async waitForExit(session: ProcessSession, yieldTimeMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.exitPromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, yieldTimeMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private createSession(
    input: StartCommandInput,
  ): ProcessSession {
    let resolveExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    return {
      id: this.nextSessionId++,
      workspaceId: input.workspaceId,
      startedAt: Date.now(),
      columns: terminalSize(input.columns, DEFAULT_COLUMNS),
      rows: terminalSize(input.rows, DEFAULT_ROWS),
      buffer: new HeadTailBuffer(this.maxBufferCharacters),
      running: true,
      exitPromise,
      resolveExit,
    };
  }

  private startPipe(session: ProcessSession, input: StartCommandInput): void {
    const shell = resolveShellCommand(input.command);
    const detached = process.platform !== "win32";
    const child = spawn(input.command, {
      cwd: input.cwd,
      env: processEnvironment({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot ?? input.cwd,
      }),
      stdio: "pipe",
      windowsHide: true,
      detached,
      shell: shell.executable,
    });

    session.process = {
      write: (data) => child.stdin.write(data),
      kill: (signal = "SIGTERM") => terminateProcessTree(child, signal, detached),
      resize: input.tty ? () => undefined : undefined,
    };
    const onData = (data: Buffer) => {
      if (!this.append(session, data.toString("utf8"))) {
        child.stdout.pause();
        child.stderr.pause();
        this.drainOutput(session, () => { child.stdout.resume(); child.stderr.resume(); });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => this.append(session, `${error.message}\n`));
    child.on("close", (code, signal) => this.finish(session, code ?? undefined, signal ?? undefined));
  }

  private async startPty(session: ProcessSession, input: StartCommandInput): Promise<void> {
    const nodePty = await loadPtyModule();

    const shell = resolveShellCommand(input.command);
    const pty = nodePty.spawn(shell.executable, shell.args, {
      cwd: input.cwd,
      env: processEnvironment({
        workspaceId: input.workspaceId,
        workspaceRoot: input.workspaceRoot ?? input.cwd,
      }),
      name: "xterm-256color",
      cols: session.columns,
      rows: session.rows,
    });

    session.process = {
      write: (data) => pty.write(data),
      kill: (signal = "SIGTERM") => terminateProcessTree({
        pid: pty.pid, kill: (requested) => { pty.kill(requested); return true; },
      }, signal, true),
      resize: (columns, rows) => pty.resize(columns, rows),
    };
    pty.onData((data) => {
      if (!this.append(session, data)) {
        pty.pause();
        this.drainOutput(session, () => pty.resume());
      }
    });
    pty.onExit(({ exitCode, signal }) => {
      this.finish(session, exitCode, signal === 0 ? undefined : String(signal));
    });
  }

  private drainOutput(session: ProcessSession, resume: () => void): void {
    session.pauseGeneration = (session.pauseGeneration ?? 0) + 1;
    if (session.drainPromise) return;
    session.drainPromise = (async () => {
      let generation: number;
      do {
        generation = session.pauseGeneration!;
        await session.logger!.drain();
      } while (session.running && !session.finishing && generation !== session.pauseGeneration);
      if (session.running && !session.finishing) resume();
    })().finally(() => { session.drainPromise = undefined; });
  }

  private finish(session: ProcessSession, exitCode?: number, signal?: string): void {
    if (!session.running || session.finishing) return;
    session.finishing = true;
    session.running = false;
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    if (session.lifetimeTimer) clearTimeout(session.lifetimeTimer);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.cleanupTimer = session.lifetimeTimer = session.idleTimer = undefined;
    session.exitCode = exitCode;
    session.signal = signal;
    session.resolveExit();
    session.cleanupTimer = setTimeout(
      () => this.sessions.delete(session.id),
      this.completedSessionTtlMs,
    );
    session.cleanupTimer.unref();
    session.flushPromise = session.logger?.finish({ exitCode, signal });
  }

  private append(session: ProcessSession, output: string): boolean {
    const ready = session.logger?.append(output) ?? true;
    session.buffer.append(output);
    return ready;
  }

  private async consume(session: ProcessSession, maxOutputTokens?: number): Promise<ProcessSnapshot> {
    if (!session.running) await session.flushPromise;
    const limit = boundedInteger(maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 100_000);
    const maxCharacters = Math.max(256, limit * 4);
    const buffered = session.buffer.drain(maxCharacters);
    const log = session.logger?.snapshot();

    return {
      sessionId: session.running ? session.id : undefined,
      output: buffered.output,
      outputTruncated: buffered.truncated,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
      wallTimeMs: Date.now() - session.startedAt,
      runId: log?.runId,
      command: log?.command,
      outputBytes: log?.outputBytes,
      outputLines: log?.outputLines,
      logError: log?.logError,
    };
  }

  private getOwnedSession(workspaceId: string, sessionId: number): ProcessSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown process session: ${sessionId}`);
    if (session.workspaceId !== workspaceId) {
      throw new Error(`Process session ${sessionId} does not belong to workspace ${workspaceId}.`);
    }
    return session;
  }

  private removeSession(sessionId: number): void {
    const session = this.sessions.get(sessionId);
    if (session?.cleanupTimer) clearTimeout(session.cleanupTimer);
    this.sessions.delete(sessionId);
  }
}
