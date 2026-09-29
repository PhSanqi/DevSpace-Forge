import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import {
  OPERATION_ID_DESCRIPTION,
  OPERATION_ID_PATTERN,
  runRecoverableOperation,
} from "./operation-receipts.js";
import {
  PAYLOAD_CHUNK_BYTES,
  PAYLOAD_READ_BYTES,
  PAYLOAD_REF_PATTERN,
  PAYLOAD_SHA256_PATTERN,
  payloadSpoolManager,
  type PayloadStatus,
} from "./payload-spool.js";
import { logEvent } from "./logger.js";
import type { WorkspaceRegistry } from "./workspaces.js";

const operationIdSchema = z
  .string()
  .regex(OPERATION_ID_PATTERN)
  .describe(OPERATION_ID_DESCRIPTION);

const payloadRefSchema = z
  .string()
  .regex(PAYLOAD_REF_PATTERN)
  .describe("Immutable workspace-scoped payload reference returned by payload_begin.");

const sha256Schema = z
  .string()
  .regex(PAYLOAD_SHA256_PATTERN)
  .describe("Lowercase SHA-256 hex digest.");

const payloadStatusShape = {
  payload_ref: payloadRefSchema,
  total_bytes: z.number().int().positive(),
  sha256: sha256Schema,
  chunk_bytes: z.number().int().positive(),
  total_chunks: z.number().int().positive(),
  received_sequences: z.array(z.number().int().nonnegative()),
  missing_sequences: z.array(z.number().int().nonnegative()),
  committed: z.boolean(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
};

function statusContent(status: PayloadStatus): Record<string, unknown> {
  return {
    payload_ref: status.payloadRef,
    total_bytes: status.totalBytes,
    sha256: status.sha256,
    chunk_bytes: status.chunkBytes,
    total_chunks: status.totalChunks,
    received_sequences: status.receivedSequences,
    missing_sequences: status.missingSequences,
    committed: status.committed,
    created_at: status.createdAt,
    updated_at: status.updatedAt,
  };
}

function statusSummary(status: PayloadStatus): string {
  return [
    `payload=${status.payloadRef}`,
    `bytes=${status.totalBytes}`,
    `chunks=${status.receivedSequences.length}/${status.totalChunks}`,
    `committed=${status.committed}`,
  ].join(" ");
}

export function registerPayloadTools(
  server: Pick<McpServer, "registerTool">,
  options: {
    config: ServerConfig;
    workspaces: WorkspaceRegistry;
  },
): void {
  const { config, workspaces } = options;
  const payloads = payloadSpoolManager(config.stateDir);

  server.registerTool(
    "payload_begin",
    {
      title: "Begin payload upload",
      description:
        `Reserve a workspace-scoped immutable payload before chunk upload. Use for large tool arguments. Chunks are ${PAYLOAD_CHUNK_BYTES} decoded bytes maximum and are never executed on arrival.`,
      inputSchema: {
        workspace_id: z.string(),
        operation_id: operationIdSchema,
        total_bytes: z.number().int().positive(),
        sha256: sha256Schema,
      },
      outputSchema: {
        result: z.string(),
        operation_id: z.string(),
        operation_replayed: z.boolean(),
        ...payloadStatusShape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, operation_id, total_bytes, sha256 }) => {
      await workspaces.getWorkspace(workspace_id);
      const recovered = await runRecoverableOperation({
        workspaceId: workspace_id,
        stateDir: config.stateDir,
        operationId: operation_id,
        tool: "payload_begin",
        request: { total_bytes, sha256 },
        execute: () => payloads.begin({
          workspaceId: workspace_id,
          operationId: operation_id,
          totalBytes: total_bytes,
          sha256,
        }),
      });
      const status = recovered.value;
      logEvent(config.logging, "info", "payload_begin", {
        workspaceId: workspace_id,
        payloadRef: status.payloadRef,
        totalBytes: status.totalBytes,
        operationReplayed: recovered.replayed,
      });
      return {
        content: [{ type: "text" as const, text: statusSummary(status) }],
        structuredContent: {
          result: statusSummary(status),
          operation_id,
          operation_replayed: recovered.replayed,
          ...statusContent(status),
        },
      };
    },
  );

  server.registerTool(
    "payload_chunk",
    {
      title: "Upload payload chunk",
      description:
        `Upload one Base64 chunk. sequence is zero-based. Decoded chunk size is fixed by payload_begin (normally ${PAYLOAD_CHUNK_BYTES} bytes except the last chunk). Duplicate identical chunks are idempotent; conflicting content fails closed.`,
      inputSchema: {
        workspace_id: z.string(),
        operation_id: operationIdSchema,
        payload_ref: payloadRefSchema,
        sequence: z.number().int().nonnegative(),
        chunk_sha256: sha256Schema,
        data_base64: z.string().min(4).max(70_000),
      },
      outputSchema: {
        result: z.string(),
        operation_id: z.string(),
        operation_replayed: z.boolean(),
        chunk_replayed: z.boolean(),
        ...payloadStatusShape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      workspace_id,
      operation_id,
      payload_ref,
      sequence,
      chunk_sha256,
      data_base64,
    }) => {
      await workspaces.getWorkspace(workspace_id);
      const recovered = await runRecoverableOperation({
        workspaceId: workspace_id,
        stateDir: config.stateDir,
        operationId: operation_id,
        tool: "payload_chunk",
        request: {
          payload_ref,
          sequence,
          chunk_sha256,
          data_base64,
        },
        execute: () => payloads.writeChunk({
          workspaceId: workspace_id,
          payloadRef: payload_ref,
          sequence,
          sha256: chunk_sha256,
          dataBase64: data_base64,
        }),
      });
      const { status, replayed: chunkReplayed } = recovered.value;
      logEvent(config.logging, "info", "payload_chunk", {
        workspaceId: workspace_id,
        payloadRef: payload_ref,
        sequence,
        chunkReplayed,
        operationReplayed: recovered.replayed,
      });
      return {
        content: [{ type: "text" as const, text: statusSummary(status) }],
        structuredContent: {
          result: statusSummary(status),
          operation_id,
          operation_replayed: recovered.replayed,
          chunk_replayed: chunkReplayed,
          ...statusContent(status),
        },
      };
    },
  );

  server.registerTool(
    "payload_status",
    {
      title: "Inspect payload upload",
      description:
        "Return received and missing chunk sequences so an interrupted upload can resume without retransmitting confirmed chunks.",
      inputSchema: {
        workspace_id: z.string(),
        payload_ref: payloadRefSchema,
      },
      outputSchema: {
        result: z.string(),
        ...payloadStatusShape,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, payload_ref }) => {
      await workspaces.getWorkspace(workspace_id);
      const status = await payloads.status(workspace_id, payload_ref);
      return {
        content: [{ type: "text" as const, text: statusSummary(status) }],
        structuredContent: {
          result: statusSummary(status),
          ...statusContent(status),
        },
      };
    },
  );

  server.registerTool(
    "payload_commit",
    {
      title: "Commit payload",
      description:
        "Atomically assemble all uploaded chunks, verify total byte length and full SHA-256, then seal the payload as immutable. No payload consumer can use an uncommitted payload.",
      inputSchema: {
        workspace_id: z.string(),
        operation_id: operationIdSchema,
        payload_ref: payloadRefSchema,
      },
      outputSchema: {
        result: z.string(),
        operation_id: z.string(),
        operation_replayed: z.boolean(),
        ...payloadStatusShape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, operation_id, payload_ref }) => {
      await workspaces.getWorkspace(workspace_id);
      const recovered = await runRecoverableOperation({
        workspaceId: workspace_id,
        stateDir: config.stateDir,
        operationId: operation_id,
        tool: "payload_commit",
        request: { payload_ref },
        execute: () => payloads.commit(workspace_id, payload_ref),
      });
      const status = recovered.value;
      logEvent(config.logging, "info", "payload_commit", {
        workspaceId: workspace_id,
        payloadRef: payload_ref,
        totalBytes: status.totalBytes,
        operationReplayed: recovered.replayed,
      });
      return {
        content: [{ type: "text" as const, text: statusSummary(status) }],
        structuredContent: {
          result: statusSummary(status),
          operation_id,
          operation_replayed: recovered.replayed,
          ...statusContent(status),
        },
      };
    },
  );

  server.registerTool(
    "payload_read",
    {
      title: "Read payload range",
      description:
        `Read a bounded range from a committed payload. length is capped at ${PAYLOAD_READ_BYTES} bytes so large payloads are progressively disclosed instead of returned in one response.`,
      inputSchema: {
        workspace_id: z.string(),
        payload_ref: payloadRefSchema,
        offset: z.number().int().nonnegative().optional(),
        length: z.number().int().positive().max(PAYLOAD_READ_BYTES).optional(),
        encoding: z.enum(["utf8", "base64"]).optional(),
      },
      outputSchema: {
        result: z.string(),
        data: z.string(),
        encoding: z.enum(["utf8", "base64"]),
        offset: z.number().int().nonnegative(),
        length: z.number().int().nonnegative(),
        total_bytes: z.number().int().positive(),
        eof: z.boolean(),
        sha256: sha256Schema,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, payload_ref, offset, length, encoding }) => {
      await workspaces.getWorkspace(workspace_id);
      const read = await payloads.read({
        workspaceId: workspace_id,
        payloadRef: payload_ref,
        offset,
        length,
        encoding,
      });
      return {
        content: [{ type: "text" as const, text: read.data }],
        structuredContent: {
          result: read.data,
          data: read.data,
          encoding: read.encoding,
          offset: read.offset,
          length: read.length,
          total_bytes: read.totalBytes,
          eof: read.eof,
          sha256: read.sha256,
        },
      };
    },
  );
}
