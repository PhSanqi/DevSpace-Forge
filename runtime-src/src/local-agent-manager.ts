import { resolve } from "node:path";
import { Result, type Result as BetterResult } from "better-result";
import {
  AgentConflictError,
  AgentProviderCancelledError,
  AgentScopeError,
  AgentStoreError,
  AgentTargetError,
  isLocalAgentError,
  isProgrammerDefect,
  type LocalAgentError,
} from "./local-agent-errors.js";
import {
  type LocalAgentProfile,
  type LocalAgentProvider,
  isLocalAgentProvider,
} from "./local-agent-profiles.js";
import {
  resolveLocalAgentTarget,
} from "./local-agent-targets.js";
import {
  type LocalAgentRecord,
  type LocalAgentStore,
  type LocalAgentTurnRecord,
  type LocalAgentWorkspaceScope,
} from "./local-agent-store.js";
import {
  type LocalAgentDriver,
  type LocalAgentRunCallbacks,
  type LocalAgentRunInput,
  type LocalAgentRuntimeContext,
  type LocalAgentWriteMode,
} from "./local-agent-runtime.js";
import {
  LocalAgentRuntimePool,
  type LocalAgentRuntimeTermination,
} from "./local-agent-runtime-pool.js";
import { assertAllowedPath } from "./roots.js";
import {
  isSubagentProviderEnabled,
  type SubagentsConfig,
} from "./local-agent-config.js";

export interface StartLocalAgentInput {
  target: string;
  prompt: string;
  workspaceRoot: string;
  workspaceId?: string;
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
}

export interface RunOverrides {
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
}

export interface LocalAgentManagerLogger {
  (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
}

export interface LocalAgentManagerOptions {
  store: LocalAgentStore;
  drivers: readonly LocalAgentDriver[];
  pool: LocalAgentRuntimePool;
  loadProfiles: (workspaceRoot: string) => Promise<LocalAgentProfile[]>;
  agentDir?: string;
  allowedRoots?: readonly string[];
  logger?: LocalAgentManagerLogger;
  subagents: SubagentsConfig;
  /** Graceful interrupt wait before the stop timeout fallback runs. */
  stopTimeoutMs?: number;
  /** Post-fallback wait for the hung turn to settle before ownership is released. */
  stopFallbackTimeoutMs?: number;
}

export type AgentStartError = AgentTargetError | AgentScopeError | AgentConflictError | AgentStoreError;
export type AgentContinueError = AgentStartError;
export type AgentLookupError = AgentTargetError | AgentScopeError | AgentStoreError;
export type AgentListError = AgentScopeError | AgentStoreError;
export type AgentWaitError = AgentLookupError;
export type AgentStopError = AgentLookupError | AgentConflictError;

export type LocalAgentWaitResult =
  | { id: string; status: "running"; wait?: "timeout" }
  | { id: string; status: "completed"; response?: string }
  | { id: string; status: "failed"; error: { code: string; message: string; retryable: boolean } }
  | { id: string; status: "stopped"; error?: { code: string; message: string; retryable: boolean } };

/** Upper bound for a graceful provider interrupt before the turn is recorded stopped. */
const LOCAL_AGENT_STOP_TIMEOUT_MS = 15_000;
/** Upper bound for the hung turn to settle after its runtime was terminated. */
const LOCAL_AGENT_STOP_FALLBACK_TIMEOUT_MS = 5_000;

interface ActiveLocalAgentTurn {
  turnId: number;
  completion: Promise<void>;
  abortController: AbortController;
  startedAt: number;
  /** Set when the bounded stop wait expired; the late completion must not overwrite the record. */
  stopRecorded: boolean;
  /**
   * Set once the turn reached the runtime pool; closes the provider runtime so
   * a provider that ignored its interrupt rejects the hung run.
   */
  terminateRuntime?: () => Promise<LocalAgentRuntimeTermination>;
}

/**
 * Owns one durable DevSpace agent's turn lifecycle. Provider runtimes remain
 * below this seam; this class only translates records into provider inputs and
 * persists the result.
 */
export class LocalAgentManager {
  private readonly store: LocalAgentStore;
  private readonly drivers = new Map<LocalAgentProvider, LocalAgentDriver>();
  private readonly pool: LocalAgentRuntimePool;
  private readonly loadProfiles: (workspaceRoot: string) => Promise<LocalAgentProfile[]>;
  private readonly agentDir?: string;
  private readonly allowedRoots?: readonly string[];
  private readonly logger?: LocalAgentManagerLogger;
  private readonly subagents: SubagentsConfig;
  private readonly stopTimeoutMs: number;
  private readonly stopFallbackTimeoutMs: number;
  private readonly activeTurns = new Map<string, ActiveLocalAgentTurn>();
  private accepting = true;
  private closePromise?: Promise<void>;

  constructor(options: LocalAgentManagerOptions) {
    this.store = options.store;
    for (const driver of options.drivers) this.drivers.set(driver.provider, driver);
    this.pool = options.pool;
    this.loadProfiles = options.loadProfiles;
    this.agentDir = options.agentDir;
    this.allowedRoots = options.allowedRoots;
    this.logger = options.logger;
    this.subagents = options.subagents;
    this.stopTimeoutMs = options.stopTimeoutMs ?? LOCAL_AGENT_STOP_TIMEOUT_MS;
    this.stopFallbackTimeoutMs = options.stopFallbackTimeoutMs ?? LOCAL_AGENT_STOP_FALLBACK_TIMEOUT_MS;
  }

  reconcileActiveRuns(message?: string): BetterResult<number, AgentStoreError> {
    return this.store.reconcileActiveRunsResult(message);
  }

  async start(input: StartLocalAgentInput): Promise<BetterResult<LocalAgentRecord, AgentStartError>> {
    const manager = this;
    return Result.gen(async function* () {
      yield* manager.acceptingResult("start");
      const workspaceRoot = yield* manager.authorizeWorkspace(
        input.workspaceRoot,
        input.workspaceId,
        "start",
      );
      const profiles = yield* Result.await(manager.loadProfilesResult(workspaceRoot, input.target));
      const target = resolveLocalAgentTarget(
        input.target,
        profiles,
        input.model,
        input.effort,
        manager.subagents.providers,
      );
      if (!target) {
        return Result.err(new AgentTargetError({
          code: "UNKNOWN_TARGET",
          target: input.target,
          retryable: false,
          message: `Unknown subagent profile or provider: ${input.target}.`,
        }));
      }
      if (target.kind === "profile" && target.profile.disabled) {
        return Result.err(new AgentTargetError({
          code: "PROVIDER_DISABLED",
          target: target.name,
          provider: target.provider,
          retryable: false,
          message: `Subagent profile is disabled: ${target.name}.`,
        }));
      }
      yield* manager.providerEnabledResult(target.provider, target.name, "start");
      yield* manager.driverResult(target.provider, "start");
      const record = yield* manager.store.createResult({
        workspaceId: input.workspaceId,
        workspaceRoot,
        profileName: target.name,
        provider: target.provider,
        model: target.model,
        effort: target.effort,
      });
      return manager.begin(record, input.prompt, {
        model: target.model,
        effort: target.effort,
        writeMode: input.writeMode,
      }, input.workspaceId);
    });
  }

  async continue(
    agentId: string,
    prompt: string,
    overrides: RunOverrides = {},
    scope: LocalAgentWorkspaceScope,
  ): Promise<BetterResult<LocalAgentRecord, AgentContinueError>> {
    const manager = this;
    return Result.gen(async function* () {
      yield* manager.acceptingResult("continue", agentId);
      const record = yield* manager.store.getByIdResult(agentId);
      if (!record) return Result.err(agentNotFound(agentId));
      yield* manager.agentWorkspaceResult(record, scope, "continue");
      const profiles = yield* Result.await(manager.loadProfilesResult(record.workspaceRoot, record.profileName));
      yield* manager.profileForRecordResult(record, profiles);
      yield* manager.providerEnabledResult(record.provider, record.profileName, "continue");
      yield* manager.driverResult(record.provider, "continue", agentId);
      return manager.begin(record, prompt, overrides, scope.workspaceId);
    });
  }

  get(
    agentId: string,
    scope: LocalAgentWorkspaceScope,
  ): BetterResult<LocalAgentRecord, AgentLookupError> {
    const lookup = this.store.getByIdResult(agentId);
    if (lookup.isErr()) return lookup;
    const record = lookup.value;
    if (!record) return Result.err(agentNotFound(agentId));
    const scoped = this.agentWorkspaceResult(record, scope, "get");
    if (scoped.isErr()) return scoped;
    return Result.ok(record);
  }

  list(scope: LocalAgentWorkspaceScope): BetterResult<LocalAgentRecord[], AgentListError> {
    return this.authorizeWorkspace(scope.workspaceRoot, scope.workspaceId, "list").andThen((workspaceRoot) => (
      this.store.listResult({
        workspaceId: scope.workspaceId,
        workspaceRoot,
      })
    ));
  }

  async wait(
    agentIds: readonly string[],
    scope: LocalAgentWorkspaceScope,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<BetterResult<LocalAgentWaitResult[], AgentWaitError>> {
    const captures: Array<{ agent: LocalAgentRecord; turn?: LocalAgentTurnRecord }> = [];
    for (const agentId of unique(agentIds)) {
      const agent = this.get(agentId, scope);
      if (agent.isErr()) return agent;
      const turn = this.store.getLatestTurnResult(agentId);
      if (turn.isErr()) return turn;
      captures.push({ agent: agent.value, turn: turn.value });
    }

    const pending: Promise<void>[] = [];
    for (const capture of captures) {
      if (capture.turn?.status !== "running") continue;
      const active = this.activeTurns.get(capture.agent.id);
      if (active?.turnId !== capture.turn.id) {
        return Result.err(new AgentStoreError(
          "wait",
          new Error(`Turn ${capture.turn.id} is not active.`),
          `Running turn state is unavailable for subagent ${capture.agent.id}.`,
        ));
      }
      pending.push(active.completion);
    }

    const timedOut = pending.length > 0
      ? await waitForTurns(pending, timeoutMs, signal)
      : false;
    const results: LocalAgentWaitResult[] = [];
    for (const capture of captures) {
      if (!capture.turn) {
        results.push(waitResultFromAgent(capture.agent, timedOut));
        continue;
      }
      const turn = this.store.getTurnByIdResult(capture.turn.id);
      if (turn.isErr()) return turn;
      results.push(turn.value
        ? waitResultFromTurn(turn.value, timedOut)
        : waitResultFromAgent(capture.agent, timedOut));
    }
    return Result.ok(results);
  }

  /**
   * Stop the agent's active turn. The manager owns one AbortController per
   * turn; drivers translate it into their provider-native interrupt. The
   * durable record and turn end as `stopped` (never `error`).
   */
  async stop(
    agentId: string,
    scope: LocalAgentWorkspaceScope,
  ): Promise<BetterResult<LocalAgentRecord, AgentStopError>> {
    const record = this.get(agentId, scope);
    if (record.isErr()) return record;
    if (record.value.status === "stopped") return Result.ok(record.value);
    const active = this.activeTurns.get(agentId);
    if (!active) {
      return Result.err(new AgentConflictError({
        code: "AGENT_CONFLICT",
        agentId,
        operation: "stop",
        retryable: false,
        message: `Agent ${agentId} does not have a running turn.`,
      }));
    }
    const provider = record.value.provider;
    const driver = isLocalAgentProvider(provider) ? this.drivers.get(provider) : undefined;
    if (!driver?.capabilities.turns.interrupt) {
      return Result.err(new AgentConflictError({
        code: "AGENT_CONFLICT",
        agentId,
        operation: "stop",
        retryable: false,
        message: `Agent ${agentId} provider does not support stopping an active turn.`,
      }));
    }
    active.abortController.abort();
    const settled = await waitForTurnSettlement(active.completion, this.stopTimeoutMs);
    if (settled) return this.get(agentId, scope);

    // The provider ignored its interrupt. Record the stop now so callers do
    // not wait forever; the late turn result is discarded in runTurn.
    active.stopRecorded = true;
    const persisted = this.store.finishTurnResult(agentId, active.turnId, {
      status: "stopped",
      error: "Subagent turn did not settle after it was stopped.",
      errorCode: "PROVIDER_CANCELLED",
      errorRetryable: false,
    });
    this.logStoppedTurn(record.value, active.startedAt, persisted.isErr());

    // Closing the provider runtime is what makes a run that ignored the
    // interrupt reject. A runtime shared with another turn is left running.
    const fallback = active.terminateRuntime
      ? await active.terminateRuntime()
      : "unavailable";
    const settledAfterFallback = await waitForTurnSettlement(
      active.completion,
      this.stopFallbackTimeoutMs,
    );
    if (!settledAfterFallback && this.activeTurns.get(agentId) === active) {
      // The turn stays hung, but this agent must remain continuable. Ownership
      // is released; the late completion will not touch a newer turn.
      this.activeTurns.delete(agentId);
    }
    this.log("warn", "agent_run_stop_timeout", {
      provider: record.value.provider,
      agentId,
      timeoutMs: this.stopTimeoutMs,
      fallback,
      settledAfterFallback,
      persistenceFailed: persisted.isErr(),
    });
    if (persisted.isErr()) return persisted;
    return this.get(agentId, scope);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    const turns = Array.from(this.activeTurns.values(), (turn) => turn.completion);
    this.closePromise = (async () => {
      // Closing pooled runtimes is what interrupts provider turns. Waiting for
      // those turns first can strand a provider process indefinitely.
      await this.pool.close();
      const turnResults = await Promise.allSettled(turns);
      for (const result of turnResults) {
        if (result.status === "rejected") {
          this.log("warn", "local_agent_close_failed", { error: errorMessage(result.reason) });
        }
      }
      this.store.close();
    })();
    return this.closePromise;
  }

  get activeTurnCount(): number {
    return this.activeTurns.size;
  }

  get runtimeCount(): number {
    return this.pool.size;
  }

  async evictIdle(now?: number): Promise<void> {
    await this.pool.evictIdle(now);
  }

  private begin(
    record: LocalAgentRecord,
    prompt: string,
    overrides: RunOverrides,
    workspaceId?: string,
  ): BetterResult<LocalAgentRecord, AgentConflictError | AgentStoreError> {
    if (this.activeTurns.has(record.id)) {
      return Result.err(new AgentConflictError({
        code: "AGENT_CONFLICT",
        agentId: record.id,
        operation: "continue",
        retryable: true,
        message: `Agent ${record.id} already has a running turn.`,
      }));
    }

    const begun = this.store.beginTurnResult(record.id, {
      prompt,
      model: overrides.model ?? record.model,
      effort: overrides.effort ?? record.effort,
    });
    if (begun.isErr()) return begun;
    // Defer invocation until after the tracking entry is visible. This keeps
    // cleanup correct even if runTurn later gains a synchronous completion path.
    const abortController = new AbortController();
    const active: ActiveLocalAgentTurn = {
      turnId: begun.value.turn.id,
      completion: Promise.resolve(),
      abortController,
      startedAt: Date.now(),
      stopRecorded: false,
    };
    active.completion = Promise.resolve().then(() => (
      this.runTurn(
        begun.value.agent,
        begun.value.turn.id,
        prompt,
        overrides,
        workspaceId,
        active,
      )
    ));
    this.activeTurns.set(record.id, active);
    void active.completion.catch(() => undefined);
    return Result.ok(begun.value.agent);
  }

  private async runTurn(
    record: LocalAgentRecord,
    turnId: number,
    prompt: string,
    overrides: RunOverrides,
    workspaceId: string | undefined,
    active: ActiveLocalAgentTurn,
  ): Promise<void> {
    const startedAt = Date.now();
    const signal = active.abortController.signal;
    this.log("info", "agent_run_started", {
      provider: record.provider,
      agentId: record.id,
      providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
    });
    try {
      const authorized = this.authorizeWorkspace(record.workspaceRoot, workspaceId, "run");
      if (authorized.isErr()) {
        this.persistRunError(record, turnId, authorized.error, startedAt);
        return;
      }
      const workspaceRoot = authorized.value;
      const authorizedRecord = workspaceRoot === record.workspaceRoot
        ? record
        : { ...record, workspaceRoot };
      const profiles = await this.loadProfilesResult(workspaceRoot, record.profileName);
      if (profiles.isErr()) {
        this.persistRunError(record, turnId, profiles.error, startedAt);
        return;
      }
      const profile = this.profileForRecordResult(record, profiles.value);
      if (profile.isErr()) {
        this.persistRunError(record, turnId, profile.error, startedAt);
        return;
      }
      const input = this.buildRunInputResult(authorizedRecord, profile.value, prompt, overrides);
      if (input.isErr()) {
        this.persistRunError(record, turnId, input.error, startedAt);
        return;
      }
      const driver = this.driverResult(record.provider, "run", record.id);
      if (driver.isErr()) {
        this.persistRunError(record, turnId, driver.error, startedAt);
        return;
      }
      const context: LocalAgentRuntimeContext = {
        agentId: record.id,
        provider: driver.value.provider,
        workspaceRoot,
        providerSessionId: record.providerSessionId,
        writeMode: input.value.writeMode,
        model: input.value.model,
        effort: input.value.effort,
        agentDir: this.agentDir,
      };
      active.terminateRuntime = () => this.pool.terminate(driver.value, context, "turn_stop_timeout");
      const callbacks: LocalAgentRunCallbacks = {
        onSessionId: (providerSessionId) => {
          const current = this.store.getByIdResult(record.id);
          if (current.isErr()) throw current.error;
          if (!current.value || current.value.providerSessionId === providerSessionId) return;
          const updated = this.store.updateResult(record.id, { providerSessionId });
          if (updated.isErr()) throw updated.error;
        },
      };
      const result = await this.pool.run(
        driver.value,
        context,
        { ...input.value, signal },
        callbacks,
      );
      if (active.stopRecorded) return;
      if (result.isErr()) {
        this.persistRunError(record, turnId, result.error, startedAt);
        return;
      }
      if (signal.aborted) {
        // The driver completed anyway after the stop request. Stopping wins.
        this.persistRunStopped(record, turnId, startedAt);
        return;
      }
      const runResult = result.value;
      const current = this.store.getByIdResult(record.id);
      if (current.isErr()) throw current.error;
      if (!current.value) return;
      const updated = this.store.finishTurnResult(record.id, turnId, {
        providerSessionId: runResult.providerSessionId ?? current.value.providerSessionId,
        status: "completed",
        response: runResult.finalResponse,
      });
      if (updated.isErr()) throw updated.error;
      this.log("info", "agent_run_completed", {
        provider: updated.value.provider,
        agentId: updated.value.id,
        providerSessionIdPrefix: updated.value.providerSessionId?.slice(0, 8),
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    } catch (error) {
      // The stop timeout already recorded this turn as stopped; a late
      // provider failure must not overwrite that record.
      if (active.stopRecorded) return;
      if (isLocalAgentError(error)) {
        this.persistRunError(record, turnId, error, startedAt);
        return;
      }
      const persisted = this.store.finishTurnResult(record.id, turnId, {
        status: "failed",
        error: "Unexpected internal subagent failure.",
        errorCode: "AGENT_INTERNAL_ERROR",
        errorRetryable: false,
      });
      this.log("error", "agent_run_failed", {
        provider: record.provider,
        agentId: record.id,
        providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
        durationMs: Math.max(0, Date.now() - startedAt),
        error: "Unexpected internal subagent failure.",
        errorType: error instanceof Error ? error.name : typeof error,
        persistenceFailed: persisted.isErr(),
      });
      throw error;
    } finally {
      // A stop that timed out may have released ownership so the agent can be
      // continued; never delete the newer turn's entry in that case.
      if (this.activeTurns.get(record.id) === active) this.activeTurns.delete(record.id);
    }
  }

  private persistRunError(
    record: LocalAgentRecord,
    turnId: number,
    error: LocalAgentError,
    startedAt: number,
  ): void {
    const cancelled = AgentProviderCancelledError.is(error);
    const persisted = this.store.finishTurnResult(record.id, turnId, {
      status: cancelled ? "stopped" : "failed",
      error: error.message,
      errorCode: error.code,
      errorRetryable: error.retryable,
    });
    this.log(cancelled ? "info" : "error", cancelled ? "agent_run_stopped" : "agent_run_failed", {
      provider: record.provider,
      agentId: record.id,
      providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode: error.code,
      error: error.message,
      causeType: safeCauseType("cause" in error ? error.cause : undefined),
      persistenceFailed: persisted.isErr(),
    });
  }

  private persistRunStopped(
    record: LocalAgentRecord,
    turnId: number,
    startedAt: number,
  ): void {
    const persisted = this.store.finishTurnResult(record.id, turnId, {
      status: "stopped",
      error: "Subagent turn was stopped.",
      errorCode: "PROVIDER_CANCELLED",
      errorRetryable: false,
    });
    this.logStoppedTurn(record, startedAt, persisted.isErr());
  }

  private logStoppedTurn(
    record: LocalAgentRecord,
    startedAt: number,
    persistenceFailed: boolean,
  ): void {
    this.log("info", "agent_run_stopped", {
      provider: record.provider,
      agentId: record.id,
      providerSessionIdPrefix: record.providerSessionId?.slice(0, 8),
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode: "PROVIDER_CANCELLED",
      persistenceFailed,
    });
  }

  private buildRunInputResult(
    record: LocalAgentRecord,
    profile: LocalAgentProfile | undefined,
    prompt: string,
    overrides: RunOverrides,
  ): BetterResult<LocalAgentRunInput, AgentTargetError> {
    const isRawProvider = record.profileName === record.provider;
    if (!profile && !isRawProvider) {
      return Result.err(new AgentTargetError({
        code: "UNKNOWN_TARGET",
        target: record.profileName,
        provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
        retryable: false,
        message: `Subagent profile not found: ${record.profileName}.`,
      }));
    }
    const body = profile?.body.trim();
    const fullPrompt = body ? `${body}\n\nTask:\n${prompt}` : prompt;
    return Result.ok({
      prompt: fullPrompt,
      workspaceRoot: record.workspaceRoot,
      providerSessionId: record.providerSessionId,
      writeMode: overrides.writeMode ?? "allowed",
      model: record.model ?? profile?.model,
      effort: record.effort ?? profile?.effort,
      modelOverrideRequested: overrides.model !== undefined,
      effortOverrideRequested: overrides.effort !== undefined,
    });
  }

  private profileForRecordResult(
    record: LocalAgentRecord,
    profiles: readonly LocalAgentProfile[],
  ): BetterResult<LocalAgentProfile | undefined, AgentTargetError> {
    if (record.profileName === record.provider) return Result.ok(undefined);
    const profile = profiles.find((candidate) => candidate.name === record.profileName);
    if (!profile) {
      return Result.err(new AgentTargetError({
        code: "UNKNOWN_TARGET",
        target: record.profileName,
        provider: isLocalAgentProvider(record.provider) ? record.provider : undefined,
        retryable: false,
        message: `Subagent profile not found: ${record.profileName}.`,
      }));
    }
    if (profile.disabled) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_DISABLED",
        target: profile.name,
        provider: profile.provider,
        retryable: false,
        message: `Subagent profile is disabled: ${profile.name}.`,
      }));
    }
    return Result.ok(profile);
  }

  private driverResult(
    provider: string,
    operation: string,
    agentId?: string,
  ): BetterResult<LocalAgentDriver, AgentTargetError> {
    if (!isLocalAgentProvider(provider)) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target: provider,
        operation,
        retryable: false,
        message: `No local agent driver is configured for provider: ${provider}.`,
      }));
    }
    const driver = this.drivers.get(provider);
    if (!driver) {
      return Result.err(new AgentTargetError({
        code: "PROVIDER_NOT_CONFIGURED",
        target: agentId ?? provider,
        provider,
        operation,
        retryable: false,
        message: `No local agent driver is configured for provider: ${provider}.`,
      }));
    }
    return Result.ok(driver);
  }

  private providerEnabledResult(
    provider: string,
    target: string,
    operation: string,
  ): BetterResult<void, AgentTargetError> {
    if (!isLocalAgentProvider(provider)) return Result.ok(undefined);
    if (isSubagentProviderEnabled(this.subagents, provider)) return Result.ok(undefined);
    return Result.err(new AgentTargetError({
      code: "PROVIDER_DISABLED",
      target,
      provider,
      operation,
      retryable: false,
      message: `Subagent provider is disabled: ${provider}.`,
    }));
  }

  private acceptingResult(
    operation: string,
    agentId?: string,
  ): BetterResult<void, AgentConflictError> {
    if (this.accepting) return Result.ok(undefined);
    return Result.err(new AgentConflictError({
      code: "AGENT_CONFLICT",
      agentId,
      operation,
      retryable: false,
      message: "Local agent manager is closed.",
    }));
  }

  private authorizeWorkspace(
    workspaceRoot: string,
    workspaceId: string | undefined,
    operation: string,
  ): BetterResult<string, AgentScopeError> {
    const normalized = resolve(workspaceRoot);
    if (!workspaceId || !this.allowedRoots) return Result.ok(normalized);
    try {
      return Result.ok(assertAllowedPath(normalized, [...this.allowedRoots]));
    } catch (cause) {
      return Result.err(new AgentScopeError({
        code: "WORKSPACE_NOT_ALLOWED",
        operation,
        retryable: false,
        cause,
        message: "Workspace root is outside configured allowed roots.",
      }));
    }
  }

  private agentWorkspaceResult(
    record: LocalAgentRecord,
    scope: LocalAgentWorkspaceScope,
    operation: string,
  ): BetterResult<void, AgentScopeError> {
    const workspaceRoot = this.authorizeWorkspace(scope.workspaceRoot, scope.workspaceId, operation);
    if (workspaceRoot.isErr()) return workspaceRoot;
    const idMismatch = scope.workspaceId !== undefined && record.workspaceId !== scope.workspaceId;
    if (workspaceRoot.value !== record.workspaceRoot || idMismatch) {
      return Result.err(new AgentScopeError({
        code: "WORKSPACE_MISMATCH",
        agentId: record.id,
        workspaceId: scope.workspaceId,
        operation,
        retryable: false,
        message: `Subagent ${record.id} belongs to a different workspace.`,
      }));
    }
    return Result.ok(undefined);
  }

  private async loadProfilesResult(
    workspaceRoot: string,
    target: string,
  ): Promise<BetterResult<LocalAgentProfile[], AgentTargetError>> {
    try {
      return Result.ok(await this.loadProfiles(workspaceRoot));
    } catch (cause) {
      if (isProgrammerDefect(cause)) throw cause;
      return Result.err(new AgentTargetError({
        code: "TARGET_RESOLUTION_FAILED",
        target,
        retryable: false,
        cause,
        message: "Unable to load subagent profiles.",
      }));
    }
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ): void {
    this.logger?.(level, event, fields);
  }
}

export function createLocalAgentManager(options: LocalAgentManagerOptions): LocalAgentManager {
  return new LocalAgentManager(options);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeCauseType(cause: unknown): string | undefined {
  if (cause instanceof Error) return cause.name;
  if (cause && typeof cause === "object" && "error" in cause) {
    const nested = (cause as { error?: unknown }).error;
    if (nested instanceof Error) return nested.name;
  }
  return cause === undefined ? undefined : typeof cause;
}

function agentNotFound(agentId: string): AgentTargetError {
  return new AgentTargetError({
    code: "AGENT_NOT_FOUND",
    target: agentId,
    retryable: false,
    message: `Unknown subagent id: ${agentId}.`,
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

async function waitForTurnSettlement(turn: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      turn.then(() => "settled" as const, () => "settled" as const),
      new Promise<"timeout">((resolveTimeout) => {
        // Not unref'd: the stop path actively awaits this bound.
        timer = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
      }),
    ]);
    return result === "settled";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForTurns(
  turns: readonly Promise<void>[],
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = timeoutMs === undefined
    ? undefined
    : new Promise<"timeout">((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
      });
  const aborted = signal
    ? new Promise<"aborted">((resolveAbort) => {
        onAbort = () => resolveAbort("aborted");
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      })
    : undefined;
  try {
    const result = await Promise.race([
      Promise.allSettled(turns).then(() => "completed" as const),
      ...(timeout ? [timeout] : []),
      ...(aborted ? [aborted] : []),
    ]);
    return result === "timeout";
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function waitResultFromTurn(turn: LocalAgentTurnRecord, timedOut: boolean): LocalAgentWaitResult {
  switch (turn.status) {
    case "running":
      return { id: turn.agentId, status: "running", ...(timedOut ? { wait: "timeout" } : {}) };
    case "completed":
      return {
        id: turn.agentId,
        status: "completed",
        ...(turn.response === undefined ? {} : { response: turn.response }),
      };
    case "failed":
      return { id: turn.agentId, status: "failed", error: turnFailure(turn) };
    case "stopped":
      return {
        id: turn.agentId,
        status: "stopped",
        ...(hasTurnFailure(turn) ? { error: turnFailure(turn) } : {}),
      };
  }
}

function waitResultFromAgent(agent: LocalAgentRecord, timedOut: boolean): LocalAgentWaitResult {
  switch (agent.status) {
    case "starting":
    case "running":
      return { id: agent.id, status: "running", ...(timedOut ? { wait: "timeout" } : {}) };
    case "idle":
      return {
        id: agent.id,
        status: "completed",
        ...(agent.latestResponse === undefined ? {} : { response: agent.latestResponse }),
      };
    case "error":
      return {
        id: agent.id,
        status: "failed",
        error: {
          code: agent.errorCode ?? "AGENT_FAILED",
          message: agent.error ?? "Subagent failed without an error message.",
          retryable: agent.errorRetryable ?? false,
        },
      };
    case "stopped":
      return {
        id: agent.id,
        status: "stopped",
        ...(agent.error || agent.errorCode || agent.errorRetryable !== undefined
          ? { error: {
              code: agent.errorCode ?? "AGENT_STOPPED",
              message: agent.error ?? "Subagent stopped.",
              retryable: agent.errorRetryable ?? false,
            } }
          : {}),
      };
  }
}

function hasTurnFailure(turn: LocalAgentTurnRecord): boolean {
  return turn.error !== undefined || turn.errorCode !== undefined || turn.errorRetryable !== undefined;
}

function turnFailure(turn: LocalAgentTurnRecord): { code: string; message: string; retryable: boolean } {
  return {
    code: turn.errorCode ?? "AGENT_FAILED",
    message: turn.error ?? "Subagent failed without an error message.",
    retryable: turn.errorRetryable ?? false,
  };
}
