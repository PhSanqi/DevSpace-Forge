import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  decodeToolResult,
  toolResultFromChatGptGlobals,
} from "./tool-result.js";

test("workspace cards can be rebuilt from structured content without result metadata", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      workspace_id: "ws_1",
      root: "/tmp/project",
      mode: "checkout",
      skills: [{ name: "tdd", description: "Tests first", path: "/tmp/tdd/SKILL.md" }],
      agents_files: [{ path: "AGENTS.md", content: "instructions" }],
      review: { available: true },
      instruction: "Reuse this workspace.",
    },
  });

  assert.equal(decoded.kind, "card");
  if (decoded.kind !== "card") return;
  assert.equal(decoded.card.tool, "open_workspace");
  assert.equal(decoded.card.workspaceId, "ws_1");
  assert.equal(decoded.card.summary?.skills, 1);
  assert.equal(decoded.card.summary?.agentsFiles, 1);
});

test("read_image results become user-visible media cards without duplicating image bytes in structured content", () => {
  const decoded = decodeToolResult({
    content: [
      { type: "text", text: JSON.stringify({ images: [{ index: 0, role: "source" }] }) },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
    structuredContent: {
      result: "metadata",
      path: "frame.png",
      mime_type: "image/png",
      size_bytes: 5,
      mode: "direct",
      image_count: 1,
      total_output_bytes: 5,
      width: 1170,
      height: 2532,
    },
  });

  assert.equal(decoded.kind, "card");
  if (decoded.kind !== "card") return;
  assert.equal(decoded.card.tool, "read_image");
  assert.equal(decoded.card.path, "frame.png");
  assert.equal(decoded.card.media?.kind, "image");
  assert.equal(decoded.card.media?.mode, "direct");
  assert.equal(decoded.card.media?.items[0]?.label, "Original");
  assert.equal(decoded.card.media?.items[0]?.data, "aGVsbG8=");
  assert.doesNotMatch(JSON.stringify(decoded.card.summary), /aGVsbG8=/);
});

test("read_images and read_video results preserve labels for visual cards", () => {
  const batch = decodeToolResult({
    content: [
      { type: "text", text: "metadata" },
      { type: "image", data: "YQ==", mimeType: "image/png" },
      { type: "image", data: "Yg==", mimeType: "image/jpeg" },
    ],
    structuredContent: {
      result: "metadata",
      images: [
        { path: "before.png", mime_type: "image/png", size_bytes: 1 },
        { path: "after.jpg", mime_type: "image/jpeg", size_bytes: 1 },
      ],
      count: 2,
      total_size_bytes: 2,
    },
  });
  assert.equal(batch.kind, "card");
  if (batch.kind === "card") {
    assert.equal(batch.card.tool, "read_images");
    assert.deepEqual(batch.card.media?.items.map((item) => item.label), ["before.png", "after.jpg"]);
  }

  const video = decodeToolResult({
    content: [
      { type: "text", text: "metadata" },
      { type: "image", data: "YQ==", mimeType: "image/jpeg" },
      { type: "image", data: "Yg==", mimeType: "image/jpeg" },
    ],
    structuredContent: {
      result: "metadata",
      path: "clip.mp4",
      duration_seconds: 3.4,
      frames: [
        { index: 0, timestamp_seconds: 0.5, mime_type: "image/jpeg", size_bytes: 1 },
        { index: 1, timestamp_seconds: 2.75, mime_type: "image/jpeg", size_bytes: 1 },
      ],
    },
  });
  assert.equal(video.kind, "card");
  if (video.kind === "card") {
    assert.equal(video.card.tool, "read_video");
    assert.deepEqual(video.card.media?.items.map((item) => item.label), ["0.50s", "2.75s"]);
  }
});

test("review results use rich metadata when the host provides it", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      workspace_id: "ws_1",
      review_ref: "a".repeat(40),
      result: "Changed 1 file (+1 -0).",
    },
    _meta: {
      card: {
        workspaceId: "ws_1",
        summary: { files: 1, additions: 1, removals: 0 },
        files: [{ path: "new.txt", type: "new", additions: 1, removals: 0 }],
        payload: { patch: "diff --git ..." },
      },
    },
  });

  assert.equal(decoded.kind, "card");
  if (decoded.kind !== "card") return;
  assert.equal(decoded.card.tool, "show_changes");
  assert.equal(decoded.card.files?.[0]?.path, "new.txt");
  assert.equal(decoded.card.payload?.patch, "diff --git ...");
});

test("review structured content becomes a reload reference when metadata is missing", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      workspace_id: "ws_1",
      review_ref: "b".repeat(40),
      result: "Changed 1 file (+1 -0).",
    },
  });

  assert.deepEqual(decoded, {
    kind: "review-reference",
    workspaceId: "ws_1",
    reviewRef: "b".repeat(40),
  });
});

test("incomplete review metadata falls back to the durable review reference", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      workspace_id: "ws_1",
      review_ref: "e".repeat(40),
      result: "Changed 1 file (+1 -0).",
    },
    _meta: { card: {} },
  });

  assert.deepEqual(decoded, {
    kind: "review-reference",
    workspaceId: "ws_1",
    reviewRef: "e".repeat(40),
  });
});

test("older review results can reload from their structured patch", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      result: "Changed 1 file (+1 -0).",
      summary: { files: 1, additions: 1, removals: 0 },
      files: [{ path: "new.txt", type: "new", additions: 1, removals: 0 }],
      patch: "diff --git a/new.txt b/new.txt",
    },
  });

  assert.equal(decoded.kind, "card");
  if (decoded.kind !== "card") return;
  assert.equal(decoded.card.tool, "show_changes");
  assert.equal(decoded.card.files?.[0]?.path, "new.txt");
  assert.equal(decoded.card.payload?.patch, "diff --git a/new.txt b/new.txt");
});

test("ChatGPT globals restore structured output and hidden MCP result metadata together", () => {
  const fullResult: CallToolResult = {
    content: [{ type: "text", text: "Changed 1 file." }],
    structuredContent: { stale: true },
    _meta: { card: { workspaceId: "ws_1", payload: { patch: "patch" } } },
  };
  const restored = toolResultFromChatGptGlobals({
    toolOutput: {
      workspace_id: "ws_1",
      review_ref: "c".repeat(40),
      result: "Changed 1 file.",
    },
    toolResponseMetadata: {
      mcp_tool_result: fullResult,
    },
  });

  assert.deepEqual(restored?.structuredContent, {
    workspace_id: "ws_1",
    review_ref: "c".repeat(40),
    result: "Changed 1 file.",
  });
  assert.deepEqual(restored?._meta, fullResult._meta);
});

test("ChatGPT globals preserve raw MCP image content for the media card", () => {
  const fullResult: CallToolResult = {
    content: [
      { type: "text", text: JSON.stringify({ images: [{ index: 0, role: "source" }] }) },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ],
    structuredContent: { stale: true },
  };
  const restored = toolResultFromChatGptGlobals({
    toolOutput: {
      result: "metadata",
      path: "frame.png",
      mime_type: "image/png",
      size_bytes: 5,
      mode: "direct",
      image_count: 1,
      total_output_bytes: 5,
      width: 100,
      height: 200,
    },
    toolResponseMetadata: {
      mcp_tool_result: fullResult,
    },
  });

  assert.ok(restored);
  if (!restored) return;
  const decoded = decodeToolResult(restored);
  assert.equal(decoded.kind, "card");
  if (decoded.kind !== "card") return;
  assert.equal(decoded.card.tool, "read_image");
  assert.equal(decoded.card.media?.items[0]?.data, "aW1hZ2U=");
});

test("ChatGPT globals also accept result metadata exposed directly", () => {
  const restored = toolResultFromChatGptGlobals({
    toolOutput: {
      workspace_id: "ws_1",
      review_ref: "d".repeat(40),
      result: "Changed 1 file.",
    },
    toolResponseMetadata: {
      card: {
        workspaceId: "ws_1",
        summary: { files: 1, additions: 1, removals: 0 },
      },
    },
  });

  assert.deepEqual(restored?._meta, {
    card: {
      workspaceId: "ws_1",
      summary: { files: 1, additions: 1, removals: 0 },
    },
  });
});
