import * as z from "zod/v4";
import { applyPatch } from "../apply-patch.js";
import { compactPreview } from "../compact-runtime/output-policy.js";
import { handleRunLogCommand } from "../compact-runtime/run-log-access.js";
import {
  MAX_PROCESS_YIELD_MS,
  type ProcessSnapshot,
} from "../process-sessions.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolLogFields,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  logToolCall,
  resultOutputSchema,
  runLoggedToolOperation,
  textBlock,
} from "./shared.js";

type CodexRegistration = (context: ToolRegistrationContext) => void;

const CODEX_INSTRUCTIONS = `Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope. Use semantic_code when available for targeted symbol structure, definitions, references, implementations, and diagnostics instead of broad file reads. If a host has cached an older tool list and semantic_code is not visible, exec_command accepts the internal compatibility forms devspace-semantic overview|find|references|implementations|declaration|diagnostics; these are handled by DevSpace and are not passed to the shell. Command output may be compacted; retrieve saved full output with devspace-log meta/read/tail/grep using the returned run_id.`;

export function codexInstructions(): string {
  return CODEX_INSTRUCTIONS;
}

export function registerCodexTools(context: ToolRegistrationContext): void {
  for (const register of CODEX_REGISTRATIONS) {
    register(context);
  }
}

const CODEX_REGISTRATIONS: readonly CodexRegistration[] = [
  registerApplyPatchTool,
  registerSemanticTools,
  registerCodexProcessTools,
];

const semanticReadActionSchema = z.enum([
  "overview",
  "find",
  "references",
  "implementations",
  "declaration",
  "diagnostics",
]);

type SemanticReadAction = z.infer<typeof semanticReadActionSchema>;
type SemanticDetail = "location" | "info" | "body";

interface SemanticRequest {
  action: SemanticReadAction;
  relativePath: string;
  symbol?: string;
  pattern?: string;
  detail?: SemanticDetail;
}

function semanticBackendRequest(request: SemanticRequest): {
  tool: string;
  args: Record<string, unknown>;
} {
  const {
    action,
    relativePath,
    symbol,
    pattern,
    detail,
  } = request;

  if (action === "overview") {
    return {
      tool: "get_symbols_overview",
      args: { relative_path: relativePath, max_answer_chars: 6_000 },
    };
  }
  if (action === "find") {
    if (!symbol) throw new Error("semantic_code action=find requires symbol.");
    return {
      tool: "find_symbol",
      args: {
        name_path_pattern: symbol,
        relative_path: relativePath,
        include_body: detail === "body",
        include_info: detail === "info",
        max_answer_chars: 6_000,
      },
    };
  }
  if (action === "references") {
    if (!symbol || !relativePath) {
      throw new Error("semantic_code action=references requires symbol and path.");
    }
    return {
      tool: "find_referencing_symbols",
      args: {
        name_path: symbol,
        relative_path: relativePath,
        max_answer_chars: 6_000,
      },
    };
  }
  if (action === "implementations") {
    if (!symbol || !relativePath) {
      throw new Error("semantic_code action=implementations requires symbol and path.");
    }
    return {
      tool: "find_implementations",
      args: {
        name_path: symbol,
        relative_path: relativePath,
        include_info: detail === "info",
        max_answer_chars: 6_000,
      },
    };
  }
  if (action === "declaration") {
    if (!relativePath || !pattern) {
      throw new Error("semantic_code action=declaration requires path and pattern.");
    }
    return {
      tool: "find_declaration",
      args: {
        relative_path: relativePath,
        regex: pattern,
        include_body: detail === "body",
        include_info: detail === "info",
      },
    };
  }
  if (!relativePath) {
    throw new Error("semantic_code action=diagnostics requires path.");
  }
  return {
    tool: "get_diagnostics_for_file",
    args: { relative_path: relativePath, max_answer_chars: 6_000 },
  };
}

function internalCommandParts(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const push = () => {
    if (current) parts.push(current);
    current = "";
  };
  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ";" || char === "|" || char === "&") {
      throw new Error(
        "DevSpace internal commands cannot be chained with shell operators.",
      );
    }
    if (/\s/.test(char)) push();
    else current += char;
  }
  if (escaped || quote) {
    throw new Error("DevSpace internal command contains an unterminated quote or escape.");
  }
  push();
  return parts;
}

function semanticCompatibilityRequest(command: string): SemanticRequest | null {
  if (!command.trimStart().startsWith("devspace-semantic")) return null;
  const parts = internalCommandParts(command);
  if (parts[0] !== "devspace-semantic") return null;
  const action = parts[1] as SemanticReadAction | undefined;
  if (!action || !semanticReadActionSchema.safeParse(action).success) {
    throw new Error(
      "usage: devspace-semantic overview <path> | find <symbol> <path|-> [location|info|body] | references <symbol> <path> | implementations <symbol> <path> | declaration <path> <regex> [location|info|body] | diagnostics <path>",
    );
  }
  const detail = (value: string | undefined): SemanticDetail | undefined => {
    if (value === undefined) return undefined;
    if (value === "location" || value === "info" || value === "body") return value;
    throw new Error(`invalid semantic detail: ${value}`);
  };

  if (action === "overview" || action === "diagnostics") {
    if (!parts[2] || parts.length !== 3) {
      throw new Error(`usage: devspace-semantic ${action} <path>`);
    }
    return { action, relativePath: parts[2] };
  }
  if (action === "find") {
    if (!parts[2] || !parts[3] || parts.length > 5) {
      throw new Error(
        "usage: devspace-semantic find <symbol> <path|-> [location|info|body]",
      );
    }
    return {
      action,
      symbol: parts[2],
      relativePath: parts[3] === "-" ? "" : parts[3],
      detail: detail(parts[4]),
    };
  }
  if (action === "references" || action === "implementations") {
    if (!parts[2] || !parts[3] || parts.length !== 4) {
      throw new Error(
        `usage: devspace-semantic ${action} <symbol> <path>`,
      );
    }
    return { action, symbol: parts[2], relativePath: parts[3] };
  }
  if (!parts[2] || !parts[3] || parts.length > 5) {
    throw new Error(
      "usage: devspace-semantic declaration <path> <regex> [location|info|body]",
    );
  }
  return {
    action,
    relativePath: parts[2],
    pattern: parts[3],
    detail: detail(parts[4]),
  };
}

function registerSemanticTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, semantic } = context;
  if (!semantic?.available) return;

  server.registerTool(
    "semantic_code",
    {
      title: "Semantic code query",
      description:
        "Query source code with Serena/LSP semantics. Prefer this for symbol-aware navigation: overview for file structure, find for symbols, references or implementations for relations, declaration for a symbol at a code pattern, and diagnostics for language-server errors. Results are bounded; refine broad queries instead of reading entire files.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        action: semanticReadActionSchema,
        path: z
          .string()
          .describe(
            "Workspace-relative source file or directory. Use an empty string only for a broad symbol find.",
          ),
        symbol: z
          .string()
          .optional()
          .describe("Symbol/name-path for find, references, or implementations."),
        pattern: z
          .string()
          .optional()
          .describe("Regex containing one capture group for declaration lookup."),
        detail: z
          .enum(["location", "info", "body"])
          .optional()
          .describe("Find/declaration detail. Defaults to location."),
      },
      outputSchema: resultOutputSchema({
        action: semanticReadActionSchema,
        truncated: z.boolean(),
        backend_age_ms: z.number().nonnegative(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, action, path: relativePath, symbol, pattern, detail }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workspace = await workspaces.getWorkspace(workspaceId);
      if (relativePath) workspaces.resolveReadPath(workspace, relativePath);

      const { tool, args } = semanticBackendRequest({
        action,
        relativePath,
        symbol,
        pattern,
        detail,
      });

      const response = await semantic.call(workspace.root, tool, args);
      logToolCall(config, {
        tool: "semantic_code",
        workspaceId,
        path: relativePath,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      const content = [textBlock(response.result)];
      return {
        content,
        structuredContent: {
          result: response.result,
          action,
          truncated: response.truncated,
          backend_age_ms: response.backendAgeMs,
        },
      };
    },
  );
}

function processResult(snapshot: ProcessSnapshot): string {
  if (snapshot.runId && snapshot.command) {
    const isError = Boolean(snapshot.signal)
      || (!snapshot.running && (snapshot.exitCode ?? 0) !== 0);
    const status = snapshot.running
      ? `running session=${snapshot.sessionId}`
      : snapshot.signal
        ? `signal=${snapshot.signal}`
        : `exit=${snapshot.exitCode ?? "unknown"}`;
    const lines = [
      `run=${snapshot.runId} status=${status} duration=${snapshot.wallTimeMs}ms output=${snapshot.outputLines ?? 0}L/${snapshot.outputBytes ?? 0}B`,
    ];
    const preview = compactPreview(snapshot.output, isError, snapshot.command);
    if (preview) lines.push(preview);
    if (snapshot.logError) {
      lines.push(
        `log=unavailable; warning=full local log persistence failed: ${snapshot.logError}`,
      );
    } else {
      lines.push(
        `log=${snapshot.runId}; more=devspace-log read ${snapshot.runId} 1 80; search=devspace-log grep ${snapshot.runId} <pattern>`,
      );
    }
    return lines.join("\n");
  }

  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output
    ? `${snapshot.output.replace(/\n$/, "")}\n${status}`
    : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    run_id: z.string().optional(),
    session_id: z.number().optional(),
    running: z.boolean(),
    exit_code: z.number().int().optional(),
    signal: z.string().optional(),
    wall_time_ms: z.number().nonnegative(),
    output_truncated: z.boolean(),
    output_bytes: z.number().nonnegative().optional(),
    output_lines: z.number().nonnegative().optional(),
    log_error: z.string().optional(),
  });
}

function processToolResponse(snapshot: ProcessSnapshot) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  return {
    content,
    structuredContent: {
      result,
      run_id: snapshot.runId,
      session_id: snapshot.sessionId,
      running: snapshot.running,
      exit_code: snapshot.exitCode,
      signal: snapshot.signal,
      wall_time_ms: snapshot.wallTimeMs,
      output_truncated: snapshot.outputTruncated,
      output_bytes: snapshot.outputBytes,
      output_lines: snapshot.outputLines,
      log_error: snapshot.logError,
    },
  };
}

function registerApplyPatchTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;

  server.registerTool(
    "apply_patch",
    {
      title: "Apply patch",
      description:
        "Apply one Codex-style patch to add, overwrite, update, delete, or move workspace files. Paths must be relative to the workspace.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        patch: z
          .string()
          .describe(
            "Patch text enclosed by *** Begin Patch and *** End Patch markers.",
          ),
      },
      outputSchema: resultOutputSchema({
        additions: z.number(),
        removals: z.number(),
        files: z.array(
          z.object({
            path: z.string(),
            previous_path: z.string().optional(),
            operation: z.enum(["add", "update", "delete", "move"]),
          }),
        ),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, patch }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const applied = await runLoggedToolOperation(
        config,
        { tool: "apply_patch", workspaceId },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          return applyPatch(workspace.root, patch);
        },
      );
      const paths = applied.files.map((file) => file.path).join(", ");
      const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
      const content = [textBlock(result)];

      return {
        content,
        structuredContent: {
          result,
          additions: applied.additions,
          removals: applied.removals,
          files: applied.files.map(({ previousPath, ...file }) => ({
            ...file,
            previous_path: previousPath,
          })),
        },
      };
    },
  );
}

function registerCodexProcessTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions, semantic } = context;

  server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a shell command in a workspace with the user's local permissions. Returns the result when it exits during the yield window, otherwise returns a session_id for write_stdin. DevSpace also handles devspace-log bounded log retrieval internally. When semantic_code is unavailable because a host cached an older tool list, devspace-semantic provides an internal read-only Serena compatibility command and is not passed to the shell.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe(
            "Allocate a pseudo-terminal for interactive commands. Defaults to false.",
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Initial PTY width. Defaults to 80."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Initial PTY height. Defaults to 24."),
        working_directory: z
          .string()
          .optional()
          .describe(
            "Working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        yield_time_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_PROCESS_YIELD_MS)
          .optional()
          .describe(
            "Milliseconds to wait before returning a running session. Defaults to 10000, maximum 12000. Use write_stdin for work that runs longer.",
          ),
        max_output_tokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspace_id,
      cmd,
      tty,
      columns,
      rows,
      working_directory,
      yield_time_ms,
      max_output_tokens,
    }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workingDirectory = working_directory;
      const yieldTimeMs = yield_time_ms;
      const maxOutputTokens = max_output_tokens;
      const workspace = await workspaces.getWorkspace(workspaceId);
      const semanticRequest = semanticCompatibilityRequest(cmd);
      if (semanticRequest) {
        if (!semantic?.available) {
          throw new Error("Serena semantic backend is not installed.");
        }
        if (semanticRequest.relativePath) {
          workspaces.resolveReadPath(workspace, semanticRequest.relativePath);
        }
        const { tool, args } = semanticBackendRequest(semanticRequest);
        const response = await semantic.call(workspace.root, tool, args);
        logToolCall(config, {
          tool: "semantic_code",
          workspaceId,
          path: semanticRequest.relativePath,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        const content = [textBlock(response.result)];
        return {
          content,
          structuredContent: {
            result: response.result,
            running: false,
            wall_time_ms: Math.round(performance.now() - startedAt),
            output_truncated: response.truncated,
          },
        };
      }
      if (processSessions.runRoot) {
        const internalResult = await handleRunLogCommand(
          cmd,
          processSessions.runRoot,
        );
        if (internalResult !== null) {
          logToolCall(config, {
            tool: "exec_command",
            workspaceId,
            workingDirectory: workingDirectory ?? ".",
            command: "devspace-log",
            commandLength: cmd.length,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });
          const content = [textBlock(internalResult)];
          return {
            content,
            structuredContent: {
              result: internalResult,
              running: false,
              wall_time_ms: Math.round(performance.now() - startedAt),
              output_truncated: false,
            },
          };
        }
      }
      const snapshot = await runLoggedToolOperation(
        config,
        {
          tool: "exec_command",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: cmd,
          commandLength: cmd.length,
        },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          const cwd = await workspaces.resolveWorkingDirectory(
            workspace,
            workingDirectory,
          );
          return processSessions.start({
            workspaceId,
            command: cmd,
            cwd,
            workspaceRoot: workspace.root,
            tty,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
          });
        },
        processLogFields,
      );

      return processToolResponse(snapshot);
    },
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspace_id: z
          .string()
          .describe("Workspace identifier used to start the process."),
        session_id: z
          .number()
          .describe("Process session identifier returned by exec_command."),
        chars: z
          .string()
          .optional()
          .describe(
            "Characters to write. Omit or pass an empty string to poll.",
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Resize a PTY to this width."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Resize a PTY to this height."),
        yield_time_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_PROCESS_YIELD_MS)
          .optional()
          .describe(
            "Milliseconds to wait for process output or completion. Maximum 12000; polling defaults to 5000 and interactive writes to 250.",
          ),
        max_output_tokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspace_id,
      session_id,
      chars,
      columns,
      rows,
      yield_time_ms,
      max_output_tokens,
    }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const sessionId = session_id;
      const yieldTimeMs = yield_time_ms;
      const maxOutputTokens = max_output_tokens;
      const snapshot = await runLoggedToolOperation(
        config,
        { tool: "write_stdin", workspaceId },
        startedAt,
        async () => {
          await workspaces.getWorkspace(workspaceId);
          return processSessions.write({
            workspaceId,
            sessionId,
            chars,
            columns,
            rows,
            yieldTimeMs,
            maxOutputTokens,
          });
        },
        processLogFields,
      );

      return processToolResponse(snapshot);
    },
  );
}

export function processLogFields(result: ProcessSnapshot): Partial<ToolLogFields> {
  const success = result.running || (!result.signal && result.exitCode === 0);
  const termination = result.signal
    ? `Process terminated by signal ${result.signal}.`
    : `Process exited with code ${result.exitCode ?? "unknown"}.`;
  return {
    sessionId: result.sessionId,
    running: result.running,
    exitCode: result.exitCode,
    success,
    ...(success ? {} : { error: termination }),
  };
}
