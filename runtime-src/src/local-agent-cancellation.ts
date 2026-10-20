import { AgentProviderCancelledError } from "./local-agent-errors.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";

/**
 * Cancellation is a first-class turn outcome, not a provider failure. Drivers
 * translate an aborted turn into this error so the manager can persist the
 * turn as `stopped` and log it at info level.
 */
export function localAgentCancelledError(
  provider: LocalAgentProvider,
  operation: string,
  cause?: unknown,
): AgentProviderCancelledError {
  return new AgentProviderCancelledError({
    code: "PROVIDER_CANCELLED",
    provider,
    operation,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
    message: `${displayProvider(provider)} agent turn was stopped.`,
  });
}

/**
 * Bind an interrupt to an abort signal. Returns a disposer that must run in a
 * finally block; without it, a runtime kept warm across turns would accumulate
 * listeners for every completed turn.
 */
export function bindLocalAgentAbort(
  signal: AbortSignal | undefined,
  interrupt: () => void | Promise<void>,
): () => void {
  if (!signal) return () => undefined;
  const onAbort = () => { void Promise.resolve(interrupt()).catch(() => undefined); };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function displayProvider(provider: LocalAgentProvider): string {
  switch (provider) {
    case "codex": return "Codex";
    case "claude": return "Claude";
    case "opencode": return "OpenCode";
    case "pi": return "Pi";
    case "cursor": return "Cursor";
    case "copilot": return "Copilot";
    case "grok": return "Grok";
  }
}
