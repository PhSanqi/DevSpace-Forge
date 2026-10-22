import assert from "node:assert/strict";
import { Result, type Result as BetterResult } from "better-result";
import type { AgentProviderError } from "./local-agent-errors.js";
import { LocalAgentRuntimePool } from "./local-agent-runtime-pool.js";
import type {
  LocalAgentDriver,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";

const context: LocalAgentRuntimeContext = {
  agentId: "agt_pool",
  provider: "codex",
  workspaceRoot: "/tmp/project",
};
const input: LocalAgentRunInput = { prompt: "inspect", workspaceRoot: "/tmp/project" };

class HoldingRuntime implements LocalAgentRuntime {
  readonly provider = "codex" as const;
  readonly inputs: LocalAgentRunInput[] = [];
  closeCount = 0;
  protected alive = true;
  protected readonly pending: Array<() => void> = [];

  async run(runInput: LocalAgentRunInput): Promise<BetterResult<LocalAgentRunResult, AgentProviderError>> {
    this.inputs.push(runInput);
    await new Promise<void>((resolve) => this.pending.push(resolve));
    return Result.ok({
      provider: this.provider,
      providerSessionId: "thread_pool",
      finalResponse: `done:${runInput.prompt}`,
      items: [],
    });
  }

  finish(): void {
    for (const resolve of this.pending.splice(0)) resolve();
  }

  releaseSession(): Promise<void> {
    return Promise.resolve();
  }

  isAlive(): boolean {
    return this.alive;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.alive = false;
  }
}

function driverFor(runtime: LocalAgentRuntime, key = "pool-runtime"): LocalAgentDriver {
  return {
    provider: "codex",
    capabilities: { turns: { interrupt: true } } as const,
    idleTimeoutMs: Number.POSITIVE_INFINITY,
    runtimeKey: () => key,
    createRuntime: async () => Result.ok(runtime),
  };
}

{
  const pool = new LocalAgentRuntimePool();
  const runtime = new HoldingRuntime();
  const missing = await pool.terminate(driverFor(runtime), context, "turn_stop_timeout");
  assert.equal(missing, "missing", "a key without a live runtime is reported as missing");
  await pool.close();
}

{
  const pool = new LocalAgentRuntimePool();
  const runtime = new HoldingRuntime();
  const driver = driverFor(runtime, "shared-runtime");
  const first = pool.run(driver, context, input);
  const second = pool.run(driver, { ...context, agentId: "agt_other" }, { ...input, prompt: "second" });
  await until(() => runtime.inputs.length === 2);
  const shared = await pool.terminate(driver, context, "turn_stop_timeout");
  assert.equal(shared, "shared", "a runtime shared with another turn is never killed");
  assert.equal(runtime.closeCount, 0);
  assert.equal(pool.size, 1);
  runtime.finish();
  assert.equal((await first).isOk(), true);
  assert.equal((await second).isOk(), true);
  await pool.close();
}

{
  const pool = new LocalAgentRuntimePool();
  const runtime = new HoldingRuntime();
  const driver = driverFor(runtime, "sole-runtime");
  const run = pool.run(driver, context, input);
  await until(() => runtime.inputs.length === 1);
  let runSettled = false;
  void run.then(() => { runSettled = true; });

  const terminated = await pool.terminate(driver, context, "turn_stop_timeout");
  assert.equal(terminated, "closed");
  assert.equal(runtime.closeCount, 1, "the sole runtime is closed");
  assert.equal(pool.size, 0, "the entry is removed before its close begins");
  assert.equal(runSettled, false, "terminate does not wait for the active run");

  runtime.finish();
  assert.equal((await run).isOk(), true);
  await pool.close();
}

{
  const pool = new LocalAgentRuntimePool({ terminateCloseTimeoutMs: 25 });
  class NeverClosingRuntime extends HoldingRuntime {
    override async close(): Promise<void> {
      this.closeCount += 1;
      this.alive = false;
      await new Promise<void>(() => undefined);
    }
  }
  const runtime = new NeverClosingRuntime();
  const driver = driverFor(runtime, "never-closing-runtime");
  const run = pool.run(driver, context, input);
  await until(() => runtime.inputs.length === 1);

  const startedAt = Date.now();
  const terminated = await pool.terminate(driver, context, "turn_stop_timeout");
  assert.equal(terminated, "close_failed", "a close that never resolves is bounded");
  assert.equal(runtime.closeCount, 1);
  assert.equal(pool.size, 0);
  assert.ok(Date.now() - startedAt < 1_000, "terminate returns near its injected bound");

  runtime.finish();
  assert.equal((await run).isOk(), true);
  await pool.close();
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(check(), true, "condition did not become true before timeout");
}
