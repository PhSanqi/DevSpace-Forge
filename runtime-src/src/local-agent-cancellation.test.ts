import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { AgentProviderCancelledError } from "./local-agent-errors.js";
import { bindLocalAgentAbort, localAgentCancelledError } from "./local-agent-cancellation.js";

const cancelled = localAgentCancelledError("codex", "run");
assert.equal(cancelled instanceof AgentProviderCancelledError, true);
assert.equal(cancelled.code, "PROVIDER_CANCELLED");
assert.equal(cancelled.provider, "codex");
assert.equal(cancelled.operation, "run");
assert.equal(cancelled.retryable, false);
assert.match(cancelled.message, /Codex agent turn was stopped/);

const cause = new Error("transport closed");
assert.equal(localAgentCancelledError("claude", "prompt", cause).cause, cause);

{
  const controller = new AbortController();
  let calls = 0;
  const unbind = bindLocalAgentAbort(controller.signal, () => { calls += 1; });
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  assert.equal(calls, 1);
  unbind();
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
}

{
  const controller = new AbortController();
  let calls = 0;
  controller.abort();
  bindLocalAgentAbort(controller.signal, () => { calls += 1; });
  assert.equal(calls, 1, "an already aborted signal interrupts immediately");
}

{
  const controller = new AbortController();
  let calls = 0;
  const unbind = bindLocalAgentAbort(controller.signal, () => { calls += 1; });
  unbind();
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  controller.abort();
  assert.equal(calls, 0, "unbinding removes the abort listener");
}

{
  const noop = bindLocalAgentAbort(undefined, () => { throw new Error("must not run"); });
  noop();
}

{
  const controller = new AbortController();
  const unbind = bindLocalAgentAbort(controller.signal, async () => {
    throw new Error("interrupt failed");
  });
  controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  unbind();
}
