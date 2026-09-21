import * as z from "zod/v4";
import {
  editFileTool,
  runShellTool,
  writeFileTool,
} from "../pi-tools.js";
import {
  OPERATION_ID_DESCRIPTION,
  OPERATION_ID_PATTERN,
  runOptionalRecoverableOperation,
} from "../operation-receipts.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolInstructionContext,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  countDiffStats,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  textBlock,
} from "./shared.js";
import { registerDurableJobTools } from "./jobs.js";

const CLAUDE_INSTRUCTIONS = `Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope. For retry-sensitive side effects, provide a stable operation_id and reuse it only for an exact retry after an unknown or lost response.`;

const operationIdSchema = z
  .string()
  .regex(OPERATION_ID_PATTERN)
  .optional()
  .describe(OPERATION_ID_DESCRIPTION);

function operationOutputSchema(): z.ZodRawShape {
  return {
    operation_id: z.string().optional(),
    operation_replayed: z.boolean().optional(),
  };
}

function operationOutput(
  operationId: string | undefined,
  replayed: boolean,
): { operation_id?: string; operation_replayed?: boolean } {
  return operationId
    ? { operation_id: operationId, operation_replayed: replayed }
    : {};
}

export function claudeInstructions({
  agents,
  skills,
}: ToolInstructionContext): string {
  return `${agents}${skills}${CLAUDE_INSTRUCTIONS}`;
}

export function registerClaudeTools(context: ToolRegistrationContext): void {
  registerClaudeMutationTools(context);
  registerDurableJobTools(context);
  registerShellTool(context);
}

const CLAUDE_SHELL_DESCRIPTION = "Run a shell command in a workspace with the user's local permissions.";

function registerClaudeMutationTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;

  server.registerTool(
    toolNames.write,
    {
      title: "Write file",
      description: "Create or completely overwrite a file in a workspace.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        operation_id: operationIdSchema,
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: resultOutputSchema(operationOutputSchema()),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, operation_id, ...input }) => {
      const workspaceId = workspace_id;
      const recovered = await runOptionalRecoverableOperation({
        workspaceId,
        stateDir: config.stateDir,
        operationId: operation_id,
        tool: toolNames.write,
        request: input,
        execute: async () => {
          const startedAt = performance.now();
          const workspace = await workspaces.getWorkspace(workspaceId);
          const path = await workspaces.resolvePath(workspace, input.path);
          const response = await writeFileTool({ ...input, path }, { cwd: workspace.root });

          if (response.isError) {
            logFailedToolResponse(
              config,
              {
                tool: toolNames.write,
                workspaceId,
                path: input.path,
              },
              response.content,
              startedAt,
            );
            return response;
          }

          logToolCall(config, {
            tool: toolNames.write,
            workspaceId,
            path: input.path,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });

          return {
            ...response,
            structuredContent: {
              result: contentText(response.content),
            },
          };
        },
      });
      if (!operation_id || !("structuredContent" in recovered.value) || !recovered.value.structuredContent) return recovered.value;
      return {
        ...recovered.value,
        structuredContent: {
          ...recovered.value.structuredContent,
          ...operationOutput(operation_id, recovered.replayed),
        },
      };
    },
  );

  server.registerTool(
    toolNames.edit,
    {
      title: "Edit file",
      description:
        "Edit one file in a workspace by replacing exact text blocks. Each old_text must match a unique, non-overlapping region of the original file.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        operation_id: operationIdSchema,
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              old_text: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              new_text: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        ...operationOutputSchema(),
        status: z.literal("applied"),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, operation_id, edits, ...input }) => {
      const workspaceId = workspace_id;
      const recovered = await runOptionalRecoverableOperation({
        workspaceId,
        stateDir: config.stateDir,
        operationId: operation_id,
        tool: toolNames.edit,
        request: { ...input, edits },
        execute: async () => {
          const startedAt = performance.now();
          const workspace = await workspaces.getWorkspace(workspaceId);
          const path = await workspaces.resolvePath(workspace, input.path);
          const response = await editFileTool({
            ...input,
            path,
            edits: edits.map(({ old_text, new_text }) => ({
              oldText: old_text,
              newText: new_text,
            })),
          }, { cwd: workspace.root });

          if (response.isError) {
            logFailedToolResponse(
              config,
              {
                tool: toolNames.edit,
                workspaceId,
                path: input.path,
              },
              response.content,
              startedAt,
            );
            return response;
          }

          const stats = countDiffStats(
            response.details?.patch ?? response.details?.diff,
          );
          const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
          const editContent = [textBlock(editResultText)];
          logToolCall(config, {
            tool: toolNames.edit,
            workspaceId,
            path: input.path,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });

          return {
            content: editContent,
            structuredContent: {
              status: "applied" as const,
              result: contentText(editContent),
            },
          };
        },
      });
      if (!operation_id || !("structuredContent" in recovered.value) || !recovered.value.structuredContent) return recovered.value;
      return {
        ...recovered.value,
        structuredContent: {
          ...recovered.value.structuredContent,
          ...operationOutput(operation_id, recovered.replayed),
        },
      };
    },
  );
}

function registerShellTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;

  server.registerTool(
    toolNames.shell,
    {
      title: "Bash",
      description: CLAUDE_SHELL_DESCRIPTION,
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        operation_id: operationIdSchema,
        command: z
          .string()
          .describe("Shell command to execute."),
        working_directory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: resultOutputSchema(operationOutputSchema()),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, operation_id, working_directory, ...input }) => {
      const workspaceId = workspace_id;
      const workingDirectory = working_directory;
      const recovered = await runOptionalRecoverableOperation({
        workspaceId,
        stateDir: config.stateDir,
        operationId: operation_id,
        tool: toolNames.shell,
        request: { ...input, working_directory },
        execute: async () => {
          const startedAt = performance.now();
          const workspace = await workspaces.getWorkspace(workspaceId);
          const cwd = await workspaces.resolveWorkingDirectory(
            workspace,
            workingDirectory,
          );
          const response = await runShellTool(input, { cwd });

          if (response.isError) {
            logFailedToolResponse(
              config,
              {
                tool: toolNames.shell,
                workspaceId,
                workingDirectory: workingDirectory ?? ".",
                command: input.command,
                commandLength: input.command.length,
              },
              response.content,
              startedAt,
            );
            return response;
          }

          logToolCall(config, {
            tool: toolNames.shell,
            workspaceId,
            workingDirectory: workingDirectory ?? ".",
            command: input.command,
            commandLength: input.command.length,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });

          return {
            ...response,
            structuredContent: {
              result: contentText(response.content),
            },
          };
        },
      });
      if (!operation_id || !("structuredContent" in recovered.value) || !recovered.value.structuredContent) return recovered.value;
      return {
        ...recovered.value,
        structuredContent: {
          ...recovered.value.structuredContent,
          ...operationOutput(operation_id, recovered.replayed),
        },
      };
    },
  );
}
