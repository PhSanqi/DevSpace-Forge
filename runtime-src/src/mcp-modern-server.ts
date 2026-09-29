import {
  McpServer,
  type ServerContext,
  type ServerOptions,
} from "@modelcontextprotocol/server";
import type { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Implementation as LegacyImplementation } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

export type McpRegistrationTarget = Pick<
  LegacyMcpServer,
  "registerTool" | "registerResource"
>;

export interface ModernMcpServerAdapter {
  server: McpServer;
  registrationTarget: McpRegistrationTarget;
}

type RegistrationReplay = (target: McpRegistrationTarget) => void;

type ModernRegisterTool = (
  name: string,
  definition: Record<string, unknown>,
  handler: (input: unknown, context: ServerContext) => unknown,
) => unknown;

type ModernRegisterResource = (...args: unknown[]) => unknown;

const LEGACY_MODEL_ARGUMENT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  agentProviders: "agent_providers",
  agentsFiles: "agents_files",
  availableAgentsFiles: "available_agents_files",
  baseRef: "base_ref",
  baseSha: "base_sha",
  dirtySource: "dirty_source",
  exitCode: "exit_code",
  maxOutputTokens: "max_output_tokens",
  newText: "new_text",
  oldText: "old_text",
  outputTruncated: "output_truncated",
  previousPath: "previous_path",
  reviewRef: "review_ref",
  sessionId: "session_id",
  skillDiagnostics: "skill_diagnostics",
  sourceRoot: "source_root",
  wallTimeMs: "wall_time_ms",
  workingDirectory: "working_directory",
  workspaceId: "workspace_id",
  yieldTimeMs: "yield_time_ms",
});

/**
 * Normalize arguments from hosts that cached DevSpace's pre-1.1 camelCase tool
 * schemas. The preprocess wrapper is intentionally invisible in generated JSON
 * Schema: new hosts continue to see only the official snake_case contract.
 */
function normalizeLegacyModelArguments(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeLegacyModelArguments);
  }
  if (!value || typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};

  // Canonical names always win when a request supplies both forms.
  for (const [key, item] of Object.entries(input)) {
    if (LEGACY_MODEL_ARGUMENT_ALIASES[key]) continue;
    normalized[key] = normalizeLegacyModelArguments(item);
  }
  for (const [key, item] of Object.entries(input)) {
    const canonical = LEGACY_MODEL_ARGUMENT_ALIASES[key];
    if (!canonical || canonical in normalized) continue;
    normalized[canonical] = normalizeLegacyModelArguments(item);
  }

  return normalized;
}

function withLegacyModelArgumentCompatibility(
  definition: Record<string, unknown>,
): Record<string, unknown> {
  const inputSchema = definition.inputSchema;
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return definition;
  }

  const schema = "_zod" in inputSchema
    ? inputSchema as z.ZodType
    : z.object(inputSchema as z.ZodRawShape);
  return {
    ...definition,
    inputSchema: z.preprocess(normalizeLegacyModelArguments, schema),
  };
}

export function createModernMcpServerAdapter(
  serverInfo: LegacyImplementation,
  options?: ServerOptions,
): ModernMcpServerAdapter {
  const server = new McpServer(serverInfo, options);
  const registerModernTool = server.registerTool.bind(server) as unknown as ModernRegisterTool;
  const registerModernResource = server.registerResource.bind(server) as unknown as ModernRegisterResource;
  const registrationTarget: McpRegistrationTarget = {
    registerTool: ((
      name: string,
      definition: Record<string, unknown>,
      handler: (input: unknown, extra: Record<string, unknown>) => unknown,
    ) => registerModernTool(
      name,
      withLegacyModelArgumentCompatibility(definition),
      async (input, context) => handler(input, legacyToolHandlerExtra(context)),
    )) as LegacyMcpServer["registerTool"],
    registerResource: ((...args: unknown[]) => {
      const callback = args.at(-1) as (...callbackArgs: unknown[]) => unknown;
      return registerModernResource(
        ...args.slice(0, -1),
        (...callbackArgs: unknown[]) => {
          const context = callbackArgs.at(-1) as ServerContext;
          return callback(
            ...callbackArgs.slice(0, -1),
            legacyToolHandlerExtra(context),
          );
        },
      );
    }) as unknown as LegacyMcpServer["registerResource"],
  };

  return {
    server,
    registrationTarget,
  };
}

export function compileMcpRegistrationSurface(
  registerSurface: (target: McpRegistrationTarget) => void,
): (target: McpRegistrationTarget) => void {
  const registrations: RegistrationReplay[] = [];
  const recordingTarget: McpRegistrationTarget = {
    registerTool: ((...args: unknown[]) => {
      registrations.push((target) => {
        (target.registerTool as (...callArgs: unknown[]) => unknown)(...args);
      });
    }) as unknown as McpRegistrationTarget["registerTool"],
    registerResource: ((...args: unknown[]) => {
      registrations.push((target) => {
        (target.registerResource as (...callArgs: unknown[]) => unknown)(...args);
      });
    }) as unknown as McpRegistrationTarget["registerResource"],
  };

  registerSurface(recordingTarget);
  const compiled = Object.freeze(registrations.slice());
  return (target) => {
    for (const replay of compiled) replay(target);
  };
}

export function modernMcpAdapterErrorLogFields(error: Error): Record<string, unknown> {
  const cause = error.cause;
  return {
    error: error.message,
    errorName: error.name,
    ...(cause === undefined ? {} : {
      cause: cause instanceof Error
        ? { name: cause.name, message: cause.message }
        : { name: typeof cause, message: String(cause) },
    }),
  };
}

function legacyToolHandlerExtra(context: ServerContext): Record<string, unknown> {
  return {
    signal: context.mcpReq.signal,
    authInfo: context.http?.authInfo,
    sessionId: context.sessionId,
    _meta: context.mcpReq._meta,
    requestId: context.mcpReq.id,
    requestInfo: context.http?.req,
    sendNotification: context.mcpReq.notify,
    sendRequest: context.mcpReq.send,
  };
}
