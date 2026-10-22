import type { Result } from "better-result";
import type { AgentProviderError } from "./local-agent-errors.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";

export type LocalAgentWriteMode = "read_only" | "allowed" | "full_access";

export interface LocalAgentRunInput {
  prompt: string;
  workspaceRoot: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  effort?: string;
  modelOverrideRequested?: boolean;
  effortOverrideRequested?: boolean;
  /**
   * Aborted when the owning turn is stopped. Drivers translate this into a
   * provider-level interrupt and must resolve with a cancelled error instead
   * of leaving the turn pending.
   */
  signal?: AbortSignal;
}

export interface LocalAgentRunResult {
  provider: LocalAgentProvider;
  providerSessionId: string | null;
  finalResponse: string;
  items: unknown[];
}

export interface LocalAgentRunCallbacks {
  /**
   * Called as soon as a provider creates or resolves a durable continuation
   * identity. The callback is awaited before the provider starts work that
   * could otherwise fail and lose that identity.
   */
  onSessionId?: (providerSessionId: string) => void | Promise<void>;
}

export interface LocalAgentRuntimeContext {
  agentId: string;
  provider: LocalAgentProvider;
  workspaceRoot: string;
  providerSessionId?: string;
  writeMode?: LocalAgentWriteMode;
  model?: string;
  effort?: string;
  agentDir?: string;
}

/**
 * A runtime is deliberately disposable. Nothing from this interface is
 * persisted; the provider session ID in LocalAgentStore is the continuation
 * identity used when a later runtime is created.
 */
export interface LocalAgentRuntime {
  readonly provider: LocalAgentProvider;
  run(
    input: LocalAgentRunInput,
    callbacks?: LocalAgentRunCallbacks,
  ): Promise<Result<LocalAgentRunResult, AgentProviderError>>;
  releaseSession(providerSessionId: string): Promise<void>;
  close(): Promise<void>;
  isAlive(): boolean;
}

/**
 * Minimal per-driver capability declaration. Only turn interruption is
 * modelled today; provider instance management deliberately stays out of the
 * driver contract.
 */
export interface LocalAgentCapabilities {
  turns: { interrupt: boolean };
}

export interface LocalAgentDriver {
  readonly provider: LocalAgentProvider;
  readonly capabilities: LocalAgentCapabilities;
  runtimeKey(context: LocalAgentRuntimeContext): string;
  createRuntime(context: LocalAgentRuntimeContext): Promise<Result<LocalAgentRuntime, AgentProviderError>>;
  readonly idleTimeoutMs?: number;
}
