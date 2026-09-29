import path from "node:path";
import { z } from "zod/v4";
import {
  OPERATION_ID_DESCRIPTION,
  OPERATION_ID_PATTERN,
  runRecoverableOperation,
  runOptionalRecoverableOperation,
} from "../operation-receipts.js";
import { WorkflowSessionManager } from "../workflow-sessions.js";
import { type ToolRegistrationContext, workspaceIdDescription } from "./types.js";

const workflowManagers = new Map<string, WorkflowSessionManager>();

function getManager(stateDir: string): WorkflowSessionManager {
  const key = path.resolve(stateDir);
  let manager = workflowManagers.get(key);
  if (!manager) {
    manager = new WorkflowSessionManager(key);
    workflowManagers.set(key, manager);
  }
  return manager;
}

export function closeWorkflowSessionManager(stateDir: string): void {
  const key = path.resolve(stateDir);
  const manager = workflowManagers.get(key);
  if (!manager) return;
  workflowManagers.delete(key);
  manager.close();
}

export function registerWorkflowSessionTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;
  const manager = () => getManager(config.stateDir);

  server.registerTool(
    "workspace_hygiene",
    {
      title: "Inspect or Prune Managed Worktree",
      description:
        "Inspect managed-worktree finish hygiene, or explicitly prune it. Prune refuses non-ignored untracked files, snapshots tracked changes or a divergent HEAD behind a recovery ref, and marks the workspace pruned so the same workspace_id can be restored later. Checkout/unmanaged workspaces are never removed.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        action: z.enum(["inspect", "prune"]),
        operation_id: z
          .string()
          .regex(OPERATION_ID_PATTERN)
          .optional()
          .describe(OPERATION_ID_DESCRIPTION),
      },
      outputSchema: {
        result: z.string(),
        operation_id: z.string().optional(),
        operation_replayed: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, action, operation_id }) => {
      if (action === "inspect") {
        const inspected = await workspaces.inspectManagedWorktreeHygiene(workspace_id);
        if (inspected.isErr()) throw inspected.error;
        return {
          content: [{ type: "text", text: JSON.stringify(inspected.value, null, 2) }],
          structuredContent: { result: JSON.stringify(inspected.value, null, 2) },
        };
      }

      if (!operation_id) {
        throw new Error(
          "workspace_hygiene action=prune requires operation_id so a lost response can be replayed without pruning twice.",
        );
      }
      const recovered = await runRecoverableOperation({
        stateDir: config.stateDir,
        workspaceId: workspace_id,
        operationId: operation_id,
        tool: "workspace_hygiene",
        request: { action },
        execute: async () => {
          const pruned = await workspaces.pruneManagedWorktreeHygiene(workspace_id);
          if (pruned.isErr()) throw pruned.error;
          return pruned.value;
        },
      });
      return {
        content: [{
          type: "text",
          text: `${recovered.replayed ? "Replayed" : "Applied"} workspace hygiene: ${recovered.value.outcome}`,
        }],
        structuredContent: {
          result: JSON.stringify(recovered.value, null, 2),
          operation_id,
          operation_replayed: recovered.replayed,
        },
      };
    },
  );

  server.registerTool(
    "workflow_start",
    {
      title: "Start Workflow Evidence Session",
      description:
        "Create a bounded task evidence record above a workspace. This records intent and workspace/worktree identity only; it is not an authorization token or a second orchestrator.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        operation_id: z
          .string()
          .regex(OPERATION_ID_PATTERN)
          .optional()
          .describe(OPERATION_ID_DESCRIPTION),
        task_intent: z.string().min(1).max(2_000).describe("Concise task goal or intent."),
      },
      outputSchema: {
        result: z.string(),
        operation_id: z.string().optional(),
        operation_replayed: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, operation_id, task_intent }) => {
      const workspace = await workspaces.getWorkspace(workspace_id);
      const recovered = await runOptionalRecoverableOperation({
        stateDir: config.stateDir,
        workspaceId: workspace_id,
        operationId: operation_id,
        tool: "workflow_start",
        request: { task_intent },
        execute: async () => manager().start(workspace, task_intent),
      });
      const record = recovered.value;
      return {
        content: [{
          type: "text",
          text: `${recovered.replayed ? "Replayed" : "Started"} workflow session: ${record.id}`,
        }],
        structuredContent: {
          result: JSON.stringify(record, null, 2),
          ...(operation_id
            ? { operation_id, operation_replayed: recovered.replayed }
            : {}),
        },
      };
    },
  );

  server.registerTool(
    "workflow_list",
    {
      title: "List Workflow Evidence Sessions",
      description:
        "List bounded workflow evidence records for the current canonical workspace root, including records created before reconnecting with a new workspace_id.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        limit: z.number().int().positive().max(100).optional(),
      },
      outputSchema: { result: z.string() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, limit = 20 }) => {
      const workspace = await workspaces.getWorkspace(workspace_id);
      const records = manager().list(workspace.canonicalRoot, limit);
      return {
        content: [{ type: "text", text: JSON.stringify(records, null, 2) }],
        structuredContent: { result: JSON.stringify(records, null, 2) },
      };
    },
  );

  server.registerTool(
    "workflow_status",
    {
      title: "Get Workflow Evidence Session",
      description:
        "Read one workflow evidence record after verifying it belongs to the current canonical workspace root.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        workflow_id: z.string().describe("Workflow ID returned by workflow_start."),
      },
      outputSchema: { result: z.string() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, workflow_id }) => {
      const workspace = await workspaces.getWorkspace(workspace_id);
      const record = manager().get(workflow_id, workspace.canonicalRoot);
      if (!record) {
        return {
          isError: true,
          content: [{ type: "text", text: `Workflow session not found for this workspace: ${workflow_id}` }],
          structuredContent: { result: "not_found" },
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
        structuredContent: { result: JSON.stringify(record, null, 2) },
      };
    },
  );

  server.registerTool(
    "workflow_record",
    {
      title: "Record Workflow Evidence",
      description:
        "Append one bounded validation evidence item and/or update review/handoff evidence for an active workflow session.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        workflow_id: z.string().describe("Workflow ID returned by workflow_start."),
        operation_id: z
          .string()
          .regex(OPERATION_ID_PATTERN)
          .optional()
          .describe(OPERATION_ID_DESCRIPTION),
        validation_status: z.enum(["pass", "fail", "info"]).optional(),
        validation_summary: z.string().min(1).max(1_000).optional(),
        validation_run_id: z.string().max(256).optional(),
        review_ref: z.string().max(512).optional(),
        handoff_summary: z.string().max(4_000).optional(),
      },
      outputSchema: {
        result: z.string(),
        operation_id: z.string().optional(),
        operation_replayed: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      workspace_id,
      workflow_id,
      operation_id,
      validation_status,
      validation_summary,
      validation_run_id,
      review_ref,
      handoff_summary,
    }) => {
      if ((validation_status === undefined) !== (validation_summary === undefined)) {
        throw new Error("validation_status and validation_summary must be provided together.");
      }
      if (
        validation_status === undefined
        && review_ref === undefined
        && handoff_summary === undefined
      ) {
        throw new Error("workflow_record requires validation, review_ref, or handoff_summary.");
      }
      const workspace = await workspaces.getWorkspace(workspace_id);
      const recovered = await runOptionalRecoverableOperation({
        stateDir: config.stateDir,
        workspaceId: workspace_id,
        operationId: operation_id,
        tool: "workflow_record",
        request: {
          workflow_id,
          validation_status,
          validation_summary,
          validation_run_id,
          review_ref,
          handoff_summary,
        },
        execute: async () => manager().record({
          id: workflow_id,
          workspaceRoot: workspace.canonicalRoot,
          ...(validation_status && validation_summary
            ? {
                validation: {
                  status: validation_status,
                  summary: validation_summary,
                  ...(validation_run_id ? { runId: validation_run_id } : {}),
                },
              }
            : {}),
          ...(review_ref !== undefined ? { reviewRef: review_ref } : {}),
          ...(handoff_summary !== undefined ? { handoffSummary: handoff_summary } : {}),
        }),
      });
      const record = recovered.value;
      return {
        content: [{
          type: "text",
          text: `${recovered.replayed ? "Replayed" : "Recorded"} workflow evidence: ${record.id}`,
        }],
        structuredContent: {
          result: JSON.stringify(record, null, 2),
          ...(operation_id
            ? { operation_id, operation_replayed: recovered.replayed }
            : {}),
        },
      };
    },
  );

  server.registerTool(
    "workflow_finish",
    {
      title: "Finish Workflow Evidence Session",
      description:
        "Mark a workflow evidence record complete with a bounded handoff/resume summary. This does not commit, push, delete, or otherwise mutate project files.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        workflow_id: z.string().describe("Workflow ID returned by workflow_start."),
        operation_id: z
          .string()
          .regex(OPERATION_ID_PATTERN)
          .optional()
          .describe(OPERATION_ID_DESCRIPTION),
        handoff_summary: z.string().min(1).max(4_000),
        review_ref: z.string().max(512).optional(),
      },
      outputSchema: {
        result: z.string(),
        operation_id: z.string().optional(),
        operation_replayed: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, workflow_id, operation_id, handoff_summary, review_ref }) => {
      const workspace = await workspaces.getWorkspace(workspace_id);
      const recovered = await runOptionalRecoverableOperation({
        stateDir: config.stateDir,
        workspaceId: workspace_id,
        operationId: operation_id,
        tool: "workflow_finish",
        request: { workflow_id, handoff_summary, review_ref },
        execute: async () => manager().finish({
          id: workflow_id,
          workspaceRoot: workspace.canonicalRoot,
          handoffSummary: handoff_summary,
          ...(review_ref !== undefined ? { reviewRef: review_ref } : {}),
        }),
      });
      const record = recovered.value;
      return {
        content: [{
          type: "text",
          text: `${recovered.replayed ? "Replayed" : "Completed"} workflow session: ${record.id}`,
        }],
        structuredContent: {
          result: JSON.stringify(record, null, 2),
          ...(operation_id
            ? { operation_id, operation_replayed: recovered.replayed }
            : {}),
        },
      };
    },
  );
}
