import assert from "node:assert/strict";
import { Panic, Result, type Result as BetterResult } from "better-result";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalAgentManager } from "./local-agent-manager.js";
import {
  AgentProviderCancelledError,
  AgentProviderExecutionError,
  type AgentProviderError,
} from "./local-agent-errors.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";
import type {
  LocalAgentDriver,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import { LocalAgentStore } from "./local-agent-store.js";
import type { SubagentsConfig } from "./local-agent-config.js";

const root = await mkdtemp(join(tmpdir(), "devspace-agent-manager-test-"));
const directRoot = await mkdtemp(join(tmpdir(), "devspace-direct-agent-manager-test-"));
const stateDir = join(root, "state");
const scope = { workspaceId: "ws_test", workspaceRoot: root };
const profile: LocalAgentProfile = {
  name: "reviewer",
  description: "Test reviewer",
  provider: "codex",
  filePath: join(root, "reviewer.md"),
  body: "Review only.",
  disabled: false,
};
const disabledProfile: LocalAgentProfile = {
  ...profile,
  name: "disabled-reviewer",
  filePath: join(root, "disabled-reviewer.md"),
  disabled: true,
};
const subagents: SubagentsConfig = {
  enabled: true,
  instructions: "on-demand",
  providers: [
    { id: "codex", enabled: true, model: "gpt-default", effort: "medium" },
    { id: "claude", enabled: true },
  ],
};

class FakeRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  readonly inputs: LocalAgentRunInput[] = [];
  closed = false;
  private releaseHold: (() => void) | undefined;

  async run(
    input: LocalAgentRunInput,
    callbacks?: { onSessionId?: (id: string) => void | Promise<void> },
  ): Promise<BetterResult<LocalAgentRunResult, AgentProviderError>> {
    this.inputs.push(input);
    if (input.prompt.includes("cancel-me")) {
      await new Promise<void>((resolve) => {
        if (input.signal?.aborted) return resolve();
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return Result.err(new AgentProviderCancelledError({
        code: "PROVIDER_CANCELLED",
        provider: this.provider,
        operation: "run",
        retryable: false,
        message: "codex agent turn was stopped.",
      }));
    }
    if (input.prompt.includes("early-fail")) {
      await callbacks?.onSessionId?.("thread_early");
      return Result.err(providerFailure("provider failed after session creation"));
    }
    if (input.prompt.includes("defect")) throw new TypeError("internal defect");
    if (input.prompt.includes("fail")) return Result.err(providerFailure("provider failed"));
    if (input.prompt.includes("hold")) {
      await new Promise<void>((resolve) => { this.releaseHold = resolve; });
    }
    return Result.ok({
      provider: this.provider,
      providerSessionId: "thread_test",
      finalResponse: `response:${input.prompt}`,
      items: [],
    });
  }

  release(): void {
    this.releaseHold?.();
    this.releaseHold = undefined;
  }

  releaseSession(): Promise<void> {
    return Promise.resolve();
  }

  isAlive(): boolean {
    return !this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.release();
  }
}

const runtimes = new Map<string, FakeRuntime>();
const driver: LocalAgentDriver = {
  provider: "codex",
  capabilities: { turns: { interrupt: true } } as const,
  runtimeKey: (context: LocalAgentRuntimeContext) => context.agentId,
  createRuntime: async (context) => {
    const runtime = new FakeRuntime();
    runtimes.set(context.agentId, runtime);
    return Result.ok(runtime);
  },
};

function providerFailure(message: string): AgentProviderExecutionError {
  return new AgentProviderExecutionError({
    code: "PROVIDER_EXECUTION_ERROR",
    provider: "codex",
    operation: "run",
    retryable: false,
    message,
  });
}

const store = new LocalAgentStore(stateDir);
const stale = store.create({
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
  profileName: "reviewer",
  provider: "codex",
});
const staleTurn = store.beginTurn(stale.id, { prompt: "interrupted turn" });
store.update(stale.id, { latestResponse: "previous response" });

const logs: Array<{ level: string; event: string }> = [];
const manager = new LocalAgentManager({
  store,
  drivers: [driver],
  pool: new LocalAgentRuntimePool(),
  loadProfiles: async () => [profile, disabledProfile],
  allowedRoots: [root],
  subagents,
  logger: (level, event) => { logs.push({ level, event }); },
});

const defectStore = new LocalAgentStore(join(root, "defect-state"));
const defectManager = new LocalAgentManager({
  store: defectStore,
  drivers: [driver],
  pool: new LocalAgentRuntimePool(),
  loadProfiles: async () => {
    throw new TypeError("profile loader defect");
  },
  allowedRoots: [root],
  subagents,
});
await assert.rejects(
  defectManager.start({
    target: "reviewer",
    prompt: "inspect",
    workspaceId: scope.workspaceId,
    workspaceRoot: root,
  }),
  (error: unknown) => Panic.is(error) && error.cause instanceof TypeError,
);
await defectManager.close();

const outside = await manager.start({
  target: "reviewer",
  prompt: "outside",
  workspaceId: scope.workspaceId,
  workspaceRoot: join(tmpdir(), "outside"),
});
assert.equal(outside.isErr(), true);
if (outside.isErr()) assert.equal(outside.error.code, "WORKSPACE_NOT_ALLOWED");

const unknown = await manager.start({
  target: "missing",
  prompt: "inspect",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
});
assert.equal(unknown.isErr(), true);
if (unknown.isErr()) assert.equal(unknown.error.code, "UNKNOWN_TARGET");

const disabled = await manager.start({
  target: "disabled-reviewer",
  prompt: "inspect",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
});
assert.equal(disabled.isErr(), true);
if (disabled.isErr()) assert.equal(disabled.error.code, "PROVIDER_DISABLED");

const unconfigured = await manager.start({
  target: "claude",
  prompt: "inspect",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
});
assert.equal(unconfigured.isErr(), true);
if (unconfigured.isErr()) assert.equal(unconfigured.error.code, "PROVIDER_NOT_CONFIGURED");

const disabledProvider = await manager.start({
  target: "pi",
  prompt: "inspect",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
});
assert.equal(disabledProvider.isErr(), true);
if (disabledProvider.isErr()) assert.equal(disabledProvider.error.code, "PROVIDER_DISABLED");

const previouslyCreatedDisabled = store.create({
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
  profileName: disabledProfile.name,
  provider: "codex",
});
store.update(previouslyCreatedDisabled.id, { status: "idle" });
const disabledContinuation = await manager.continue(previouslyCreatedDisabled.id, "inspect", {}, scope);
assert.equal(disabledContinuation.isErr(), true);
if (disabledContinuation.isErr()) assert.equal(disabledContinuation.error.code, "PROVIDER_DISABLED");

assert.equal(getRecord(stale.id).status, "running");

const mismatchedGet = manager.get(stale.id, { workspaceId: "ws_current", workspaceRoot: root });
assert.equal(mismatchedGet.isErr(), true);
if (mismatchedGet.isErr()) assert.equal(mismatchedGet.error.code, "WORKSPACE_MISMATCH");

unwrap(manager.reconcileActiveRuns());
assert.equal(getRecord(stale.id).status, "error");
assert.equal(getRecord(stale.id).latestResponse, "previous response");
assert.equal(getRecord(stale.id).error, "DevSpace restarted while this agent turn was running.");
assert.equal(getRecord(stale.id).errorCode, "DAEMON_UNAVAILABLE");
assert.equal(getRecord(stale.id).errorRetryable, true);
assert.equal(store.getTurnById(staleTurn.turn.id)?.status, "failed");
assert.equal(store.getTurnById(staleTurn.turn.id)?.errorCode, "DAEMON_UNAVAILABLE");

const first = unwrap(await manager.start({
  target: "reviewer",
  prompt: "hold",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
assert.equal(first.status, "running");
assert.equal(first.model, "gpt-default");
assert.equal(first.effort, "medium");
await waitFor(() => runtimes.get(first.id)?.inputs.length === 1);
const conflict = await manager.continue(first.id, "another prompt", {}, scope);
assert.equal(conflict.isErr(), true);
if (conflict.isErr()) {
  assert.equal(conflict.error.code, "AGENT_CONFLICT");
  assert.equal("agentId" in conflict.error ? conflict.error.agentId : undefined, first.id);
}

runtimes.get(first.id)!.release();
await waitFor(() => getRecord(first.id).status === "idle");
assert.equal(getRecord(first.id).providerSessionId, "thread_test");
assert.match(getRecord(first.id).latestResponse ?? "", /Task:\nhold/);
assert.deepEqual(
  store.listTurns(first.id).map((turn) => ({ prompt: turn.prompt, status: turn.status })),
  [{ prompt: "hold", status: "completed" }],
);

const continued = unwrap(await manager.continue(first.id, "continue", {
  model: "gpt-run",
  effort: "high",
}, scope));
assert.equal(continued.status, "running");
await waitFor(() => getRecord(first.id).status === "idle");
assert.equal(getRecord(first.id).model, "gpt-run");
assert.equal(getRecord(first.id).effort, "high");
assert.deepEqual(
  store.listTurns(first.id).map((turn) => ({ prompt: turn.prompt, status: turn.status })),
  [
    { prompt: "hold", status: "completed" },
    { prompt: "continue", status: "completed" },
  ],
);

const second = unwrap(await manager.start({
  target: "reviewer",
  prompt: "second agent",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => getRecord(second.id).status === "idle");
assert.notEqual(first.id, second.id);
assert.equal(runtimes.size, 2, "different agents receive independent logical runtimes");

const stopLogStart = logs.length;
const stoppable = unwrap(await manager.start({
  target: "reviewer",
  prompt: "cancel-me for stop",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => runtimes.get(stoppable.id)?.inputs.length === 1);
const stopped = unwrap(await manager.stop(stoppable.id, scope));
assert.equal(stopped.status, "stopped");
assert.equal(stopped.errorCode, "PROVIDER_CANCELLED");
assert.equal(store.getLatestTurn(stoppable.id)?.status, "stopped");
assert.equal(store.getLatestTurn(stoppable.id)?.errorCode, "PROVIDER_CANCELLED");
assert.equal(
  logs.slice(stopLogStart).some((entry) => entry.event === "agent_run_stopped" && entry.level === "info"),
  true,
  "a stopped turn is logged as an informational stop",
);
assert.equal(
  logs.slice(stopLogStart).some((entry) => entry.event === "agent_run_failed"),
  false,
  "a stopped turn is not logged as a provider failure",
);
const stoppedAgain = unwrap(await manager.stop(stoppable.id, scope));
assert.equal(stoppedAgain.status, "stopped", "stopping an already stopped agent is a no-op");

const idleStop = await manager.stop(second.id, scope);
assert.equal(idleStop.isErr(), true);
if (idleStop.isErr()) assert.equal(idleStop.error.code, "AGENT_CONFLICT");

const missingStop = await manager.stop("agt_missing", scope);
assert.equal(missingStop.isErr(), true);
if (missingStop.isErr()) assert.equal(missingStop.error.code, "AGENT_NOT_FOUND");

{
  const gatedStore = new LocalAgentStore(join(root, "gated-state"));
  const gatedRuntimes: FakeRuntime[] = [];
  let releaseCreation!: () => void;
  const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve; });
  const gatedDriver: LocalAgentDriver = {
    provider: "codex",
    capabilities: { turns: { interrupt: true } } as const,
    runtimeKey: (context: LocalAgentRuntimeContext) => context.agentId,
    createRuntime: async () => {
      await creationGate;
      const runtime = new FakeRuntime();
      gatedRuntimes.push(runtime);
      return Result.ok(runtime);
    },
  };
  const gatedManager = new LocalAgentManager({
    store: gatedStore,
    drivers: [gatedDriver],
    pool: new LocalAgentRuntimePool(),
    loadProfiles: async () => [profile],
    allowedRoots: [root],
    subagents,
  });
  const gated = unwrap(await gatedManager.start({
    target: "reviewer",
    prompt: "cancel-me gated start",
    workspaceId: scope.workspaceId,
    workspaceRoot: root,
  }));
  const gatedStop = gatedManager.stop(gated.id, scope);
  releaseCreation();
  assert.equal(unwrap(await gatedStop).status, "stopped");
  assert.equal(
    gatedRuntimes[0]?.inputs[0]?.signal?.aborted,
    true,
    "a stop requested before the runtime starts passes an already-aborted signal",
  );
  await gatedManager.close();
}

{
  const limitedStore = new LocalAgentStore(join(root, "limited-state"));
  const limitedRuntimes = new Map<string, FakeRuntime>();
  const limitedDriver: LocalAgentDriver = {
    provider: "claude",
    capabilities: { turns: { interrupt: false } } as const,
    runtimeKey: (context: LocalAgentRuntimeContext) => context.agentId,
    createRuntime: async (context) => {
      const runtime = new FakeRuntime();
      limitedRuntimes.set(context.agentId, runtime);
      return Result.ok(runtime);
    },
  };
  const limitedManager = new LocalAgentManager({
    store: limitedStore,
    drivers: [limitedDriver],
    pool: new LocalAgentRuntimePool(),
    loadProfiles: async () => [profile],
    allowedRoots: [root],
    subagents,
  });
  const limitedRecord = limitedStore.create({
    workspaceId: scope.workspaceId,
    workspaceRoot: root,
    profileName: "claude",
    provider: "claude",
  });
  unwrap(await limitedManager.continue(limitedRecord.id, "hold unsupported", {}, scope));
  await waitFor(() => limitedRuntimes.get(limitedRecord.id)?.inputs.length === 1);
  const unsupportedStop = await limitedManager.stop(limitedRecord.id, scope);
  assert.equal(unsupportedStop.isErr(), true);
  if (unsupportedStop.isErr()) assert.equal(unsupportedStop.error.code, "AGENT_CONFLICT");
  limitedRuntimes.get(limitedRecord.id)!.release();
  await waitFor(() => unwrap(limitedManager.get(limitedRecord.id, scope)).status === "idle");
  await limitedManager.close();
}

const failed = unwrap(await manager.start({
  target: "reviewer",
  prompt: "fail",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => getRecord(failed.id).status === "error");
assert.equal(getRecord(failed.id).error, "provider failed");
assert.equal(getRecord(failed.id).errorCode, "PROVIDER_EXECUTION_ERROR");
assert.equal(getRecord(failed.id).errorRetryable, false);
assert.equal(store.getLatestTurn(failed.id)?.status, "failed");
assert.equal(store.getLatestTurn(failed.id)?.error, "provider failed");
const recovered = unwrap(await manager.continue(failed.id, "recovered", {}, scope));
assert.equal(recovered.status, "running", "provider Err releases active-turn ownership");
await waitFor(() => getRecord(failed.id).status === "idle");

const earlyFailure = unwrap(await manager.start({
  target: "reviewer",
  prompt: "early-fail",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => getRecord(earlyFailure.id).status === "error");
assert.equal(getRecord(earlyFailure.id).providerSessionId, "thread_early");

const waitingOne = unwrap(await manager.start({
  target: "reviewer",
  prompt: "hold wait one",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
const waitingTwo = unwrap(await manager.start({
  target: "reviewer",
  prompt: "hold wait two",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => runtimes.get(waitingOne.id)?.inputs.length === 1);
await waitFor(() => runtimes.get(waitingTwo.id)?.inputs.length === 1);
let multiWaitSettled = false;
const multiWait = manager.wait([waitingOne.id, waitingTwo.id, waitingOne.id], scope)
  .then((result) => {
    multiWaitSettled = true;
    return result;
  });
runtimes.get(waitingOne.id)!.release();
await waitFor(() => getRecord(waitingOne.id).status === "idle");
assert.equal(multiWaitSettled, false, "multi-agent wait must remain pending until every turn finishes");
runtimes.get(waitingTwo.id)!.release();
assert.deepEqual(unwrap(await multiWait).map((result) => ({ id: result.id, status: result.status })), [
  { id: waitingOne.id, status: "completed" },
  { id: waitingTwo.id, status: "completed" },
]);

const timedWaitAgent = unwrap(await manager.start({
  target: "reviewer",
  prompt: "hold timed wait",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => runtimes.get(timedWaitAgent.id)?.inputs.length === 1);
assert.deepEqual(unwrap(await manager.wait([earlyFailure.id, timedWaitAgent.id], scope, 5)), [
  {
    id: earlyFailure.id,
    status: "failed",
    error: {
      code: "PROVIDER_EXECUTION_ERROR",
      message: "provider failed after session creation",
      retryable: false,
    },
  },
  { id: timedWaitAgent.id, status: "running", wait: "timeout" },
]);
runtimes.get(timedWaitAgent.id)!.release();
await waitFor(() => getRecord(timedWaitAgent.id).status === "idle");

const cancelledWaitAgent = unwrap(await manager.start({
  target: "reviewer",
  prompt: "hold cancelled wait",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => runtimes.get(cancelledWaitAgent.id)?.inputs.length === 1);
const waitAbort = new AbortController();
const cancelledWait = manager.wait([cancelledWaitAgent.id], scope, undefined, waitAbort.signal);
waitAbort.abort();
assert.deepEqual(unwrap(await cancelledWait), [{ id: cancelledWaitAgent.id, status: "running" }]);
assert.equal(getRecord(cancelledWaitAgent.id).status, "running", "cancelling a waiter must not stop its turn");
runtimes.get(cancelledWaitAgent.id)!.release();
await waitFor(() => getRecord(cancelledWaitAgent.id).status === "idle");

const invalidWait = await manager.wait([waitingOne.id, "agt_missing"], scope, 5);
assert.equal(invalidWait.isErr(), true);
if (invalidWait.isErr()) assert.equal(invalidWait.error.code, "AGENT_NOT_FOUND");

const wrongWorkspace = await manager.continue(
  first.id,
  "wrong workspace",
  {},
  { workspaceId: scope.workspaceId, workspaceRoot: join(root, "other") },
);
assert.equal(wrongWorkspace.isErr(), true);
if (wrongWorkspace.isErr()) assert.equal(wrongWorkspace.error.code, "WORKSPACE_MISMATCH");

const wrongWorkspaceId = await manager.continue(
  first.id,
  "wrong workspace id",
  {},
  { workspaceId: "ws_other", workspaceRoot: root },
);
assert.equal(wrongWorkspaceId.isErr(), true);
if (wrongWorkspaceId.isErr()) assert.equal(wrongWorkspaceId.error.code, "WORKSPACE_MISMATCH");

const directOutside = unwrap(await manager.start({
  target: "reviewer",
  prompt: "direct outside allowed roots",
  workspaceRoot: directRoot,
}));
await waitFor(() => unwrap(manager.get(directOutside.id, { workspaceRoot: directRoot })).status === "idle");
assert.equal(directOutside.workspaceId, undefined);
assert.deepEqual(unwrap(manager.list({ workspaceRoot: directRoot })).map((record) => record.id), [
  directOutside.id,
]);

const direct = unwrap(await manager.start({
  target: "reviewer",
  prompt: "direct harness",
  workspaceRoot: root,
}));
await waitFor(() => unwrap(manager.get(direct.id, { workspaceRoot: root })).status === "idle");
assert.equal(direct.workspaceId, undefined);
assert.equal(unwrap(manager.get(first.id, { workspaceRoot: root })).id, first.id);
const directWrongId = manager.get(direct.id, { workspaceId: "ws_other", workspaceRoot: root });
assert.equal(directWrongId.isErr(), true);
if (directWrongId.isErr()) assert.equal(directWrongId.error.code, "WORKSPACE_MISMATCH");

const defect = unwrap(await manager.start({
  target: "reviewer",
  prompt: "defect",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => getRecord(defect.id).status === "error");
assert.equal(getRecord(defect.id).errorCode, "AGENT_INTERNAL_ERROR");
assert.notEqual(getRecord(defect.id).errorCode, "PROVIDER_EXECUTION_ERROR");

const shuttingDown = unwrap(await manager.start({
  target: "reviewer",
  prompt: "hold during shutdown",
  workspaceId: scope.workspaceId,
  workspaceRoot: root,
}));
await waitFor(() => runtimes.get(shuttingDown.id)?.inputs.length === 1);
const closing = manager.close();
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(runtimes.get(shuttingDown.id)?.closed, true);
await closing;

{
  // A provider that ignores its interrupt until its runtime is closed.
  class CloseSettlesRuntime implements LocalAgentRuntime {
    readonly provider = "codex" as const;
    readonly inputs: LocalAgentRunInput[] = [];
    closed = false;
    private releaseHold: (() => void) | undefined;
    private readonly held = new Promise<void>((resolve) => { this.releaseHold = resolve; });

    async run(input: LocalAgentRunInput): Promise<BetterResult<LocalAgentRunResult, AgentProviderError>> {
      this.inputs.push(input);
      await this.held;
      return Result.ok({
        provider: this.provider,
        providerSessionId: "thread_stubborn",
        finalResponse: "late response",
        items: [],
      });
    }

    release(): void {
      this.releaseHold?.();
      this.releaseHold = undefined;
    }

    releaseSession(): Promise<void> {
      return Promise.resolve();
    }

    isAlive(): boolean {
      return !this.closed;
    }

    async close(): Promise<void> {
      this.closed = true;
      this.release();
    }
  }

  const fallbackStore = new LocalAgentStore(join(root, "stop-fallback-state"));
  const fallbackLogs: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  const fallbackRuntimes: CloseSettlesRuntime[] = [];
  const fallbackDriver: LocalAgentDriver = {
    provider: "codex",
    capabilities: { turns: { interrupt: true } } as const,
    runtimeKey: (context: LocalAgentRuntimeContext) => context.agentId,
    createRuntime: async () => {
      const runtime = new CloseSettlesRuntime();
      fallbackRuntimes.push(runtime);
      return Result.ok(runtime);
    },
  };
  const fallbackManager = new LocalAgentManager({
    store: fallbackStore,
    drivers: [fallbackDriver],
    pool: new LocalAgentRuntimePool(),
    loadProfiles: async () => [profile],
    allowedRoots: [root],
    subagents,
    stopTimeoutMs: 25,
    stopFallbackTimeoutMs: 50,
    logger: (level, event, fields) => { fallbackLogs.push({ level, event, fields }); },
  });

  const stubborn = unwrap(await fallbackManager.start({
    target: "reviewer",
    prompt: "ignore every interrupt",
    workspaceId: scope.workspaceId,
    workspaceRoot: root,
  }));
  await waitFor(() => fallbackRuntimes[0]?.inputs.length === 1);

  const stopped = unwrap(await fallbackManager.stop(stubborn.id, scope));
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.errorCode, "PROVIDER_CANCELLED");
  assert.equal(fallbackRuntimes[0]?.closed, true, "the stop fallback closes the hung runtime");
  assert.equal(
    fallbackLogs.some((entry) => entry.level === "info" && entry.event === "agent_run_stopped"),
    true,
    "the timeout path still records an informational stop",
  );
  const fallbackTimeoutLog = fallbackLogs.find((entry) => entry.event === "agent_run_stop_timeout");
  assert.ok(fallbackTimeoutLog, "the stop timeout is reported");
  assert.equal(fallbackTimeoutLog.level, "warn");
  assert.equal(fallbackTimeoutLog.fields.fallback, "closed");
  assert.equal(fallbackTimeoutLog.fields.settledAfterFallback, true);
  assert.equal(fallbackTimeoutLog.fields.timeoutMs, 25);
  assert.equal(fallbackTimeoutLog.fields.persistenceFailed, false);
  assert.equal(fallbackManager.activeTurnCount, 0);

  const continued = unwrap(await fallbackManager.continue(stubborn.id, "second turn", {}, scope));
  assert.equal(continued.status, "running", "the agent can be continued after a stop timeout");
  await waitFor(() => fallbackRuntimes[1]?.inputs.length === 1);
  fallbackRuntimes[1]!.release();
  await waitFor(() => statusOf(fallbackManager, stubborn.id) === "idle");
  await fallbackManager.close();

  // A provider that ignores its interrupt and refuses to close at all.
  class DeafRuntime implements LocalAgentRuntime {
    readonly provider = "codex" as const;
    readonly inputs: LocalAgentRunInput[] = [];
    closeAttempts = 0;
    refuseClose = true;
    private releaseHold: (() => void) | undefined;
    private readonly held = new Promise<void>((resolve) => { this.releaseHold = resolve; });

    async run(input: LocalAgentRunInput): Promise<BetterResult<LocalAgentRunResult, AgentProviderError>> {
      this.inputs.push(input);
      await this.held;
      return Result.ok({
        provider: this.provider,
        providerSessionId: "thread_deaf",
        finalResponse: "late response",
        items: [],
      });
    }

    release(): void {
      this.releaseHold?.();
      this.releaseHold = undefined;
    }

    releaseSession(): Promise<void> {
      return Promise.resolve();
    }

    isAlive(): boolean {
      return true;
    }

    close(): Promise<void> {
      this.closeAttempts += 1;
      if (this.refuseClose) return new Promise<void>(() => undefined);
      this.release();
      return Promise.resolve();
    }
  }

  const deafStore = new LocalAgentStore(join(root, "stop-deaf-state"));
  const deafLogs: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  const deafRuntimes: DeafRuntime[] = [];
  const deafDriver: LocalAgentDriver = {
    provider: "codex",
    capabilities: { turns: { interrupt: true } } as const,
    runtimeKey: (context: LocalAgentRuntimeContext) => context.agentId,
    createRuntime: async () => {
      const runtime = new DeafRuntime();
      deafRuntimes.push(runtime);
      return Result.ok(runtime);
    },
  };
  const deafManager = new LocalAgentManager({
    store: deafStore,
    drivers: [deafDriver],
    pool: new LocalAgentRuntimePool({ terminateCloseTimeoutMs: 25 }),
    loadProfiles: async () => [profile],
    allowedRoots: [root],
    subagents,
    stopTimeoutMs: 25,
    stopFallbackTimeoutMs: 25,
    logger: (level, event, fields) => { deafLogs.push({ level, event, fields }); },
  });

  const deaf = unwrap(await deafManager.start({
    target: "reviewer",
    prompt: "deaf provider",
    workspaceId: scope.workspaceId,
    workspaceRoot: root,
  }));
  await waitFor(() => deafRuntimes[0]?.inputs.length === 1);

  const deafStop = unwrap(await deafManager.stop(deaf.id, scope));
  assert.equal(deafStop.status, "stopped");
  assert.equal(deafRuntimes[0]?.closeAttempts, 1, "the stop fallback attempts to close the runtime");
  assert.equal(deafManager.activeTurnCount, 0, "a hung turn releases ownership after both timeouts");
  const deafTimeoutLog = deafLogs.find((entry) => entry.event === "agent_run_stop_timeout");
  assert.ok(deafTimeoutLog);
  assert.equal(deafTimeoutLog.fields.fallback, "close_failed");
  assert.equal(deafTimeoutLog.fields.settledAfterFallback, false);

  const deafContinued = unwrap(await deafManager.continue(deaf.id, "second turn", {}, scope));
  assert.equal(deafContinued.status, "running", "the agent can be continued after an unkillable timeout");
  await waitFor(() => deafRuntimes.length === 2 && deafRuntimes[1].inputs.length === 1);
  const secondRuntime = deafRuntimes[1]!;
  secondRuntime.refuseClose = false;

  deafRuntimes[0]!.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(deafManager.activeTurnCount, 1, "a late completion does not delete the newer turn's entry");
  assert.equal(statusOf(deafManager, deaf.id), "running", "a late completion does not overwrite the record");
  assert.equal(deafStore.getLatestTurn(deaf.id)?.status, "running");
  assert.equal(deafStore.listTurns(deaf.id).length, 2);

  secondRuntime.release();
  await waitFor(() => statusOf(deafManager, deaf.id) === "idle");
  await deafManager.close();
}

await manager.close();
await rm(root, { recursive: true, force: true });
await rm(directRoot, { recursive: true, force: true });

function getRecord(id: string) {
  return unwrap(manager.get(id, scope));
}

function statusOf(target: LocalAgentManager, id: string): string {
  const record = target.get(id, scope);
  return record.isErr() ? "error" : record.value.status;
}

function unwrap<T, E>(result: BetterResult<T, E>): T {
  if (result.isErr()) throw result.error;
  return result.value;
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(check(), true, "condition did not become true before timeout");
}
