import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  ReviewFileType,
  ToolResultCard,
  ToolResultMediaItem,
} from "./card-types.js";

export type DecodedToolResult =
  | { kind: "card"; card: ToolResultCard }
  | { kind: "review-reference"; workspaceId: string; reviewRef: string }
  | { kind: "invalid" };

export interface ChatGptToolGlobals {
  toolOutput?: unknown;
  toolResponseMetadata?: unknown;
}

export function decodeToolResult(result: CallToolResult): DecodedToolResult {
  const structured = asRecord(result.structuredContent);
  const metaCard = cardFields(asRecord(asRecord(result._meta)?.card));

  if (structured) {
    const mediaCard = structuredMediaCard(result, structured);
    if (mediaCard) return { kind: "card", card: mediaCard };

    const workspaceId = stringField(structured.workspace_id);
    const reviewRef = stringField(structured.review_ref);
    if (workspaceId && reviewRef) {
      if (isCompleteReviewCard(metaCard)) {
        return {
          kind: "card",
          card: {
            ...metaCard,
            tool: "show_changes",
            workspaceId,
          },
        };
      }
      return { kind: "review-reference", workspaceId, reviewRef };
    }

    if (typeof structured.patch === "string" && Array.isArray(structured.files)) {
      const legacyCard = cardFields({
        ...structured,
        payload: { patch: structured.patch },
      });
      if (legacyCard) {
        return { kind: "card", card: { ...legacyCard, tool: "show_changes" } };
      }
    }

    const root = stringField(structured.root);
    const mode = workspaceMode(structured.mode);
    if (workspaceId && root && mode) {
      const structuredCard = structuredWorkspaceCardFields(structured) ?? {};
      return {
        kind: "card",
        card: {
          ...structuredCard,
          ...metaCard,
          tool: "open_workspace",
          workspaceId,
          root,
          mode,
          summary: metaCard?.summary ?? workspaceSummary(structuredCard),
        },
      };
    }
  }

  // Existing conversations created before reviewRef was added can still render
  // while the host supplies their live MCP Apps result metadata.
  if (metaCard?.workspaceId && (metaCard.files?.length || metaCard.payload?.patch)) {
    return { kind: "card", card: { ...metaCard, tool: "show_changes" } };
  }
  if (metaCard?.workspaceId && metaCard.root && metaCard.mode) {
    return { kind: "card", card: { ...metaCard, tool: "open_workspace" } };
  }

  return { kind: "invalid" };
}

function structuredMediaCard(
  result: CallToolResult,
  structured: Record<string, unknown>,
): ToolResultCard | undefined {
  const contentImages: ToolResultMediaItem[] = result.content.flatMap((item) => {
    if (item.type !== "image") return [];
    const mimeType = item.mimeType;
    if (mimeType !== "image/jpeg" && mimeType !== "image/png") return [];
    if (typeof item.data !== "string" || item.data.length === 0) return [];
    return [{ data: item.data, mimeType }];
  });
  if (contentImages.length === 0) return undefined;

  const path = stringField(structured.path);
  const mode = structured.mode === "direct" || structured.mode === "tiled"
    ? structured.mode
    : undefined;

  if (mode) {
    const metadata = arrayRecordsFromResultText(result)?.map((item) => ({
      role: stringField(item.role),
    }));
    return {
      tool: "read_image",
      path,
      media: {
        kind: "image",
        mode,
        items: contentImages.map((image, index) => ({
          ...image,
          label: mode === "direct"
            ? "Original"
            : metadata?.[index]?.role === "overview"
              ? "Overview"
              : metadata?.[index]?.role === "tile"
                ? `Detail ${index}`
                : `Preview ${index + 1}`,
        })),
      },
      summary: {
        count: contentImages.length,
        mode,
        width: numberField(structured.width),
        height: numberField(structured.height),
        sizeBytes: numberField(structured.size_bytes),
      },
    };
  }

  const batchImages = arrayRecords(structured.images);
  if (batchImages && numberField(structured.count) !== undefined) {
    return {
      tool: "read_images",
      path: batchImages.length === 1 ? stringField(batchImages[0]?.path) : undefined,
      media: {
        kind: "image-batch",
        items: contentImages.map((image, index) => ({
          ...image,
          label: stringField(batchImages[index]?.path) ?? `Image ${index + 1}`,
        })),
      },
      summary: {
        count: contentImages.length,
        sizeBytes: numberField(structured.total_size_bytes),
      },
    };
  }

  const frames = arrayRecords(structured.frames);
  if (frames && numberField(structured.duration_seconds) !== undefined) {
    return {
      tool: "read_video",
      path,
      media: {
        kind: "video-frames",
        items: contentImages.map((image, index) => {
          const timestamp = numberField(frames[index]?.timestamp_seconds);
          return {
            ...image,
            label: timestamp === undefined ? `Frame ${index + 1}` : `${timestamp.toFixed(2)}s`,
          };
        }),
      },
      summary: {
        count: contentImages.length,
        durationSeconds: numberField(structured.duration_seconds),
        sizeBytes: numberField(structured.total_output_bytes),
      },
    };
  }

  return undefined;
}

function arrayRecordsFromResultText(
  result: CallToolResult,
): Array<Record<string, unknown>> | undefined {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) return undefined;
  try {
    return arrayRecords(asRecord(JSON.parse(text))?.images);
  } catch {
    return undefined;
  }
}

function structuredWorkspaceCardFields(
  record: Record<string, unknown> | undefined,
): Partial<ToolResultCard> | undefined {
  if (!record) return undefined;
  const worktreeRecord = asRecord(record.worktree);
  return cardFields({
    root: record.root,
    mode: record.mode,
    sourceRoot: record.source_root,
    worktree: worktreeRecord
      ? {
          path: worktreeRecord.path,
          baseRef: worktreeRecord.base_ref,
          baseSha: worktreeRecord.base_sha,
          dirtySource: worktreeRecord.dirty_source,
          detached: worktreeRecord.detached,
          managed: worktreeRecord.managed,
      }
      : undefined,
    review: record.review,
    agentsFiles: record.agents_files,
    availableAgentsFiles: record.available_agents_files,
    skills: record.skills,
    agentProviders: record.agent_providers,
    agents: record.agents,
    instruction: record.instruction,
  });
}

function isCompleteReviewCard(
  card: Partial<ToolResultCard> | undefined,
): card is Partial<ToolResultCard> & {
  files: NonNullable<ToolResultCard["files"]>;
  payload: { patch: string };
  summary: Record<string, unknown>;
} {
  if (!card || !Array.isArray(card.files) || typeof card.payload?.patch !== "string") {
    return false;
  }
  return numberField(card.summary?.files) !== undefined
    && numberField(card.summary?.additions) !== undefined
    && numberField(card.summary?.removals) !== undefined;
}

export function toolResultFromChatGptGlobals(
  globals: ChatGptToolGlobals | undefined,
): CallToolResult | undefined {
  if (!globals) return undefined;

  const responseMetadata = asRecord(globals.toolResponseMetadata);
  const metadataResult = mcpToolResult(globals.toolResponseMetadata);
  const structuredContent = asRecord(globals.toolOutput)
    ?? asRecord(metadataResult?.structuredContent);
  const resultMeta = asRecord(metadataResult?._meta)
    ?? directResultMeta(responseMetadata);
  if (!metadataResult && !structuredContent && !resultMeta) return undefined;

  return {
    ...(metadataResult ?? { content: [] }),
    ...(structuredContent ? { structuredContent } : {}),
    ...(resultMeta ? { _meta: resultMeta } : {}),
  } as CallToolResult;
}

function directResultMeta(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  return "card" in metadata ? metadata : undefined;
}

function mcpToolResult(value: unknown): CallToolResult | undefined {
  const metadata = asRecord(value);
  if (!metadata) return undefined;

  const direct = asRecord(metadata.mcp_tool_result);
  if (direct) return direct as CallToolResult;

  const callToolResult = asRecord(metadata.call_tool_result);
  const nested = asRecord(callToolResult?.mcp_tool_result);
  return nested ? nested as CallToolResult : undefined;
}

function cardFields(record: Record<string, unknown> | undefined): Partial<ToolResultCard> | undefined {
  if (!record) return undefined;

  const agentsFiles = arrayRecords(record.agentsFiles)?.map((item) => ({
    path: stringField(item.path),
    content: stringField(item.content),
  }));
  const availableAgentsFiles = arrayRecords(record.availableAgentsFiles)?.map((item) => ({
    path: stringField(item.path),
  }));
  const skills = arrayRecords(record.skills)?.map((item) => ({
    name: stringField(item.name),
    description: stringField(item.description),
    path: stringField(item.path),
  }));
  const agentProviders = arrayRecords(record.agentProviders)?.map((item) => ({
    id: stringField(item.id),
    model: stringField(item.model),
    effort: stringField(item.effort),
    note: stringField(item.note),
  }));
  const agents = arrayRecords(record.agents)?.map((item) => ({
    name: stringField(item.name),
    description: stringField(item.description),
    provider: stringField(item.provider),
    model: stringField(item.model),
    effort: stringField(item.effort),
  }));
  const files = arrayRecords(record.files)?.map((item) => ({
    path: stringField(item.path),
    previousPath: stringField(item.previousPath),
    type: reviewFileType(item.type),
    additions: numberField(item.additions),
    removals: numberField(item.removals),
  }));
  const worktreeRecord = asRecord(record.worktree);
  const reviewRecord = asRecord(record.review);
  const summary = asRecord(record.summary);
  const payloadRecord = asRecord(record.payload);

  return definedFields({
    workspaceId: stringField(record.workspaceId),
    path: stringField(record.path),
    root: stringField(record.root),
    workspaceReused: booleanField(record.workspaceReused),
    includeBootstrapContext: booleanField(record.includeBootstrapContext),
    mode: workspaceMode(record.mode),
    sourceRoot: stringField(record.sourceRoot),
    worktree: worktreeRecord
      ? {
          path: stringField(worktreeRecord.path),
          baseRef: stringField(worktreeRecord.baseRef),
          baseSha: stringField(worktreeRecord.baseSha),
          dirtySource: booleanField(worktreeRecord.dirtySource),
          detached: booleanField(worktreeRecord.detached),
          managed: booleanField(worktreeRecord.managed),
        }
      : undefined,
    review: reviewAvailability(reviewRecord),
    summary,
    files,
    payload: payloadRecord ? { patch: stringField(payloadRecord.patch) } : undefined,
    agentsFiles,
    availableAgentsFiles,
    skills,
    agentProviders,
    agents,
    instruction: stringField(record.instruction),
  });
}

function workspaceSummary(card: Partial<ToolResultCard>): Record<string, unknown> {
  return {
    mode: card.mode,
    agentsFiles: card.agentsFiles?.length ?? 0,
    availableAgentsFiles: card.availableAgentsFiles?.length ?? 0,
    skills: card.skills?.length ?? 0,
    agentProviders: card.agentProviders?.length ?? 0,
    agents: card.agents?.length ?? 0,
  };
}

function reviewAvailability(
  record: Record<string, unknown> | undefined,
): ToolResultCard["review"] {
  if (!record || typeof record.available !== "boolean") return undefined;
  if (record.available) return { available: true };
  const reason = stringField(record.reason);
  return reason ? { available: false, reason } : undefined;
}

function reviewFileType(value: unknown): ReviewFileType | undefined {
  return value === "change"
    || value === "rename-pure"
    || value === "rename-changed"
    || value === "new"
    || value === "deleted"
    ? value
    : undefined;
}

function workspaceMode(value: unknown): ToolResultCard["mode"] {
  return value === "checkout" || value === "worktree" ? value : undefined;
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function definedFields<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as T;
}
