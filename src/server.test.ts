import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Request, RequestHandler, Response as ExpressResponse } from "express";
import { loadConfig, type ServerConfig, type ToolMode } from "./config.js";
import type { LocalAgentProviderAvailability } from "./local-agent-availability.js";
import { buildLocalAgentProviderStatuses } from "./local-agent-catalog.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { SerenaSemanticManager } from "./serena-semantic.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { closeOperationReceiptManager } from "./operation-receipts.js";
import {
  DEVSPACE_HTTP_HEADERS_TIMEOUT_MS,
  DEVSPACE_HTTP_KEEP_ALIVE_TIMEOUT_MS,
  configureHttpServer,
  createMcpServer,
  createServer,
  observeHttpResponseStart,
  waitForExpressMiddleware,
} from "./server.js";
import { closeDurableJobManager } from "./tool-surfaces/jobs.js";
import { closeWorkflowSessionManager } from "./tool-surfaces/workflows.js";
import { SqliteWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";

const execFileAsync = promisify(execFile);

test("HTTP server transport timeouts keep long MCP connections alive", () => {
  const fakeServer = {
    keepAliveTimeout: 0,
    headersTimeout: 0,
  };
  configureHttpServer(fakeServer as never);
  assert.equal(fakeServer.keepAliveTimeout, DEVSPACE_HTTP_KEEP_ALIVE_TIMEOUT_MS);
  assert.equal(fakeServer.headersTimeout, DEVSPACE_HTTP_HEADERS_TIMEOUT_MS);
  assert.ok(fakeServer.headersTimeout > fakeServer.keepAliveTimeout);
});

test("HTTP response start timing records only the first writeHead", () => {
  let writes = 0;
  let starts = 0;
  const response = {
    writeHead() {
      writes += 1;
      return this;
    },
  } as unknown as ExpressResponse;
  const timing = observeHttpResponseStart(response, () => {
    starts += 1;
  });
  response.writeHead(200);
  response.writeHead(204);
  assert.equal(writes, 2);
  assert.equal(starts, 1);
  assert.equal(typeof timing.startedAt, "number");
});

test("public HTTP proxy requests redirect to HTTPS and HTTPS responses carry HSTS", async (t) => {
  const { localBaseUrl } = await httpServerFixture(t, "devspace-https-hardening-");
  const rawGet = (path: string, headers: Record<string, string>) => new Promise<{
    status: number | undefined;
    headers: import("node:http").IncomingHttpHeaders;
  }>((resolve, reject) => {
    const target = new URL(path, localBaseUrl);
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode, headers: response.headers }));
    });
    request.once("error", reject);
    request.end();
  });
  const redirected = await rawGet("/healthz?source=http", {
      host: "example.test",
      "x-forwarded-proto": "http",
  });
  assert.equal(redirected.status, 308);
  assert.equal(redirected.headers.location, "https://example.test/healthz?source=http");

  const secure = await rawGet("/healthz", {
      host: "example.test",
      "x-forwarded-proto": "https",
  });
  assert.equal(secure.status, 200);
  assert.equal(secure.headers["strict-transport-security"], "max-age=3600");
});

test("origin logs correlate response start, MCP tool completion and response finish", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(
    t,
    "devspace-origin-lifecycle-test-",
    true,
  );
  const events: Array<Record<string, unknown>> = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    for (const argument of args) {
      if (typeof argument !== "string" || !argument.startsWith("{")) continue;
      try {
        const entry = JSON.parse(argument) as Record<string, unknown>;
        if (typeof entry.event === "string") events.push(entry);
      } catch { /* Other test output is not a structured DevSpace event. */ }
    }
  };
  try {
    const response = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
      name: "open_workspace",
      arguments: { path: root },
    }, { headers: { "cf-ray": "test-edge-request-123" } });
    assert.equal(response.status, 200, await response.clone().text());
    await response.text();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    console.log = originalLog;
  }
  const request = events.find((entry) => entry.event === "http_request_start"
    && entry.path === "/mcp" && entry.method === "POST" && entry.toolStartedCount === 0
    && events.some((other) => other.requestId === entry.requestId && other.event === "mcp_request_complete"
      && other.rpcToolName === "open_workspace"));
  assert.ok(request, "the origin must log a correlated MCP request");
  assert.equal(request.cfRay, "test-edge-request-123");
  const matching = events.filter((entry) => entry.requestId === request.requestId);
  const responseStart = matching.find((entry) => entry.event === "http_response_start");
  const complete = matching.find((entry) => entry.event === "mcp_request_complete");
  const finished = matching.find((entry) => entry.event === "http_request");
  assert.equal(responseStart?.transport_established, true);
  assert.equal(responseStart?.firstByteObservation, "origin_write_head_not_client_receipt");
  assert.equal(typeof responseStart?.response_start_ms, "number");
  assert.equal(complete?.toolStartedCount, 1);
  assert.equal(complete?.toolResolvedCount, 1);
  assert.equal(complete?.activeToolCount, 0);
  assert.equal(finished?.outcome, "response_finished");
  assert.equal(finished?.toolResolvedCount, 1);
});

test("origin distinguishes a disconnected request with an in-flight MCP tool", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(
    t,
    "devspace-origin-abort-test-",
    true,
  );
  const opened = await postModernMcp(localBaseUrl, accessToken, "tools/call", {
    name: "open_workspace",
    arguments: { path: root },
  });
  const openedBody = await opened.json() as {
    result?: { structuredContent?: { workspace_id?: string } };
  };
  const workspaceId = openedBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const events: Array<Record<string, unknown>> = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const capture = (...args: unknown[]) => {
    for (const argument of args) {
      if (typeof argument !== "string" || !argument.startsWith("{")) continue;
      try {
        const entry = JSON.parse(argument) as Record<string, unknown>;
        if (typeof entry.event === "string") events.push(entry);
      } catch { /* Ignore non-JSON log output. */ }
    }
  };
  console.log = capture;
  console.warn = capture;
  try {
    const controller = new AbortController();
    const pending = postModernMcp(localBaseUrl, accessToken, "tools/call", {
      name: "exec_command",
      arguments: {
        workspace_id: workspaceId,
        cmd: "node -e \"require('node:fs').writeFileSync('abort-started','');setTimeout(()=>{},1800)\"",
        yield_time_ms: 12_000,
      },
    }, { signal: controller.signal }).then(
      () => false,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    await waitForFile(join(root, "abort-started"));
    controller.abort();
    assert.equal(await pending, true);
    for (let attempt = 0; attempt < 40 && !events.some((entry) => entry.event === "http_request_aborted"); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  const rpc = events.find((entry) => entry.event === "mcp_request" && entry.rpcToolName === "exec_command");
  assert.ok(rpc, "expected origin MCP request evidence");
  const closed = events.find((entry) => entry.event === "http_request_aborted" && entry.requestId === rpc.requestId);
  assert.equal(closed?.outcome, "connection_closed_before_finish");
  assert.equal(closed?.disconnectPhase, "while_tool_running_before_response");
  assert.equal(closed?.responseStarted, false);
  assert.equal(closed?.transport_established, true);
  assert.equal(closed?.activeToolCount, 1);
});

test("tool modes expose the expected host-facing tool surface", async (t) => {
  const cases: Array<{
    mode: ToolMode;
    expected: string[];
  }> = [
    {
      mode: "claude",
      expected: [
        "open_workspace",
        "payload_begin",
        "payload_chunk",
        "payload_status",
        "payload_commit",
        "payload_read",
        "read",
        "read_image",
        "write",
        "edit",
        "bash",
        "show_changes",
        "job_start",
        "job_list",
        "job_status",
        "job_logs",
        "job_cancel",
        "job_wait",
        "devspace_info",
        "workspace_hygiene",
        "workflow_start",
        "workflow_list",
        "workflow_status",
        "workflow_record",
        "workflow_finish",
      ],
    },
    {
      mode: "codex",
      expected: [
        "open_workspace",
        "payload_begin",
        "payload_chunk",
        "payload_status",
        "payload_commit",
        "payload_read",
        "read",
        "read_image",
        "apply_patch",
        "context_pack",
        "exec_command",
        "write_stdin",
        "show_changes",
        "job_start",
        "job_list",
        "job_status",
        "job_logs",
        "job_cancel",
        "job_wait",
        "devspace_info",
        "workspace_hygiene",
        "workflow_start",
        "workflow_list",
        "workflow_status",
        "workflow_record",
        "workflow_finish",
      ],
    },
  ];

  for (const { mode, expected } of cases) {
    await t.test(mode, async (nested) => {
      const context = await fixture(nested, { toolMode: mode, uiEnabled: false });
      const tools = await context.client.listTools();

      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        expected.sort(),
      );
    });
  }
});

test("Codex mutation operation_id safely replays an identical lost response", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const opened = structuredContent(
    await callOpen(context.client, context.project, "operation-replay"),
  );
  const workspaceId = opened.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const operationId = "retry-apply-0001";
  const patch = [
    "*** Begin Patch",
    "*** Add File: replay.txt",
    "+once",
    "*** End Patch",
  ].join("\n");
  const request = {
    name: "apply_patch",
    arguments: {
      workspace_id: workspaceId,
      operation_id: operationId,
      patch,
    },
  };

  const first = await context.client.callTool(request);
  const replayed = await context.client.callTool(request);
  assert.notEqual(first.isError, true);
  assert.notEqual(replayed.isError, true);
  assert.equal(structuredContent(first).operation_replayed, false);
  assert.equal(structuredContent(replayed).operation_replayed, true);
  assert.equal(structuredContent(replayed).operation_id, operationId);
  assert.equal(await readFile(join(context.project, "replay.txt"), "utf8"), "once\n");
});

test("payload spool completes an MCP upload and feeds exec_command and apply_patch only after commit", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const opened = structuredContent(
    await callOpen(context.client, context.project, "payload-e2e"),
  );
  const workspaceId = opened.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const upload = async (label: string, bytes: Buffer) => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const begun = structuredContent(await context.client.callTool({
      name: "payload_begin",
      arguments: {
        workspace_id: workspaceId,
        operation_id: `payload-begin-${label}-0001`,
        total_bytes: bytes.length,
        sha256,
      },
    }));
    const payloadRef = begun.payload_ref;
    assert.equal(typeof payloadRef, "string");
    assert.equal(begun.committed, false);

    const chunkBytes = Number(begun.chunk_bytes);
    assert.ok(chunkBytes > 0);
    const totalChunks = Number(begun.total_chunks);
    for (let sequence = 0; sequence < totalChunks; sequence += 1) {
      const chunkStart = sequence * chunkBytes;
      const chunkBuffer = bytes.subarray(
        chunkStart,
        Math.min(bytes.length, chunkStart + chunkBytes),
      );
      const chunk = structuredContent(await context.client.callTool({
        name: "payload_chunk",
        arguments: {
          workspace_id: workspaceId,
          operation_id: `payload-chunk-${label}-${String(sequence).padStart(4, "0")}`,
          payload_ref: payloadRef,
          sequence,
          chunk_sha256: createHash("sha256").update(chunkBuffer).digest("hex"),
          data_base64: chunkBuffer.toString("base64"),
        },
      }));
      assert.equal(chunk.chunk_replayed, false);
    }

    const status = structuredContent(await context.client.callTool({
      name: "payload_status",
      arguments: { workspace_id: workspaceId, payload_ref: payloadRef },
    }));
    assert.equal(status.committed, false);
    assert.equal((status.received_sequences as unknown[]).length, totalChunks);
    assert.deepEqual(status.missing_sequences, []);

    const committed = structuredContent(await context.client.callTool({
      name: "payload_commit",
      arguments: {
        workspace_id: workspaceId,
        operation_id: `payload-commit-${label}-0001`,
        payload_ref: payloadRef,
      },
    }));
    assert.equal(committed.committed, true);
    return payloadRef as string;
  };

  const command = Buffer.from(
    `node -e "require('node:fs').writeFileSync('payload-command.txt','from-payload')"`,
    "utf8",
  );
  const commandSha = createHash("sha256").update(command).digest("hex");
  const begunCommand = structuredContent(await context.client.callTool({
    name: "payload_begin",
    arguments: {
      workspace_id: workspaceId,
      operation_id: "payload-begin-command-uncommitted",
      total_bytes: command.length,
      sha256: commandSha,
    },
  }));
  const uncommitted = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspace_id: workspaceId,
      operation_id: "payload-exec-uncommitted-0001",
      payload_ref: begunCommand.payload_ref,
      yield_time_ms: 2_000,
    },
  });
  assert.equal(uncommitted.isError, true);

  const commandRef = await upload("command", command);
  const read = structuredContent(await context.client.callTool({
    name: "payload_read",
    arguments: {
      workspace_id: workspaceId,
      payload_ref: commandRef,
      offset: 0,
      length: 12,
      encoding: "utf8",
    },
  }));
  assert.equal(read.data, command.subarray(0, 12).toString("utf8"));
  assert.equal(read.length, 12);

  const executed = await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspace_id: workspaceId,
      operation_id: "payload-exec-command-0001",
      payload_ref: commandRef,
      yield_time_ms: 2_000,
    },
  });
  assert.notEqual(executed.isError, true);
  assert.equal(await readFile(join(context.project, "payload-command.txt"), "utf8"), "from-payload");

  const largePatchLines = Array.from(
    { length: 4_000 },
    (_, index) => `+payload-line-${String(index).padStart(4, "0")}-xxxxxxxx`,
  );
  const patchBytes = Buffer.from([
    "*** Begin Patch",
    "*** Add File: payload-patch.txt",
    ...largePatchLines,
    "*** End Patch",
  ].join("\n"), "utf8");
  assert.ok(patchBytes.length > 48 * 1024);
  const patchRef = await upload("patch", patchBytes);
  const patched = await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspace_id: workspaceId,
      operation_id: "payload-apply-patch-0001",
      payload_ref: patchRef,
    },
  });
  assert.notEqual(patched.isError, true);
  const patchedText = await readFile(join(context.project, "payload-patch.txt"), "utf8");
  assert.match(patchedText, /^payload-line-0000-/);
  assert.match(patchedText, /payload-line-3999-xxxxxxxx\n$/);
});

test("workspace hygiene prunes recoverably and replays a lost response", async (t) => {
  const context = await fixture(t, { git: true, toolMode: "codex", uiEnabled: false });
  const opened = structuredContent(await context.client.callTool({
    name: "open_workspace",
    arguments: { path: context.project, mode: "worktree" },
  }));
  const workspaceId = opened.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const changed = await context.client.callTool({
    name: "apply_patch",
    arguments: {
      workspace_id: workspaceId,
      operation_id: "hygiene-edit-0001",
      patch: [
        "*** Begin Patch",
        "*** Update File: README.md",
        "@@",
        "-hello",
        "+hello from recoverable hygiene",
        "*** End Patch",
      ].join("\n"),
    },
  });
  assert.notEqual(changed.isError, true);

  const inspected = structuredContent(await context.client.callTool({
    name: "workspace_hygiene",
    arguments: { workspace_id: workspaceId, action: "inspect" },
  }));
  const inspection = JSON.parse(String(inspected.result)) as {
    disposition: string;
    prunable: boolean;
    recoveryKind?: string;
  };
  assert.equal(inspection.disposition, "tracked_changes");
  assert.equal(inspection.prunable, true);
  assert.equal(inspection.recoveryKind, "stash");

  const pruneRequest = {
    name: "workspace_hygiene",
    arguments: {
      workspace_id: workspaceId,
      action: "prune",
      operation_id: "hygiene-prune-0001",
    },
  };
  const first = structuredContent(await context.client.callTool(pruneRequest));
  const replay = structuredContent(await context.client.callTool(pruneRequest));
  assert.equal(first.operation_replayed, false);
  assert.equal(replay.operation_replayed, true);
  assert.equal(first.result, replay.result);
  const result = JSON.parse(String(first.result)) as {
    outcome: string;
    recoveryKind?: string;
    recoveryRef?: string;
  };
  assert.equal(result.outcome, "removed");
  assert.equal(result.recoveryKind, "stash");
  assert.match(result.recoveryRef ?? "", /^refs\/devspace\/recovery\/ws_/);

  const restored = await context.client.callTool({
    name: "read",
    arguments: { workspace_id: workspaceId, path: "README.md" },
  });
  assert.notEqual(restored.isError, true);
  const restoredText = (restored.content as Array<{ type: string; text?: string }>)
    .find((item) => item.type === "text")?.text ?? "";
  assert.match(restoredText, /hello from recoverable hygiene/);
});

test("durable job_start operation_id replays the same job after a lost response", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const opened = structuredContent(
    await callOpen(context.client, context.project, "job-operation-replay"),
  );
  const workspaceId = opened.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const operationId = "retry-job-0001";
  const request = {
    name: "job_start",
    arguments: {
      workspace_id: workspaceId,
      operation_id: operationId,
      command: process.platform === "win32" ? "echo durable-replay" : "printf durable-replay",
    },
  };
  const first = structuredContent(await context.client.callTool(request));
  const replay = structuredContent(await context.client.callTool(request));
  assert.equal(first.operation_id, operationId);
  assert.equal(first.operation_replayed, false);
  assert.equal(replay.operation_id, operationId);
  assert.equal(replay.operation_replayed, true);
  const firstJob = JSON.parse(String(first.result)) as { id: string };
  const replayJob = JSON.parse(String(replay.result)) as { id: string };
  assert.equal(replayJob.id, firstJob.id);
  const waited = await context.client.callTool({
    name: "job_wait",
    arguments: {
      job_id: firstJob.id,
      timeout_seconds: 3,
    },
  });
  assert.notEqual(waited.isError, true);
});

test("durable jobs remain discoverable after reconnecting the same workspace", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const first = structuredContent(
    await callOpen(context.client, context.project, "job-rebind-before"),
  );
  const second = structuredContent(
    await callOpen(context.client, context.project, "job-rebind-after"),
  );
  assert.notEqual(first.workspace_id, second.workspace_id);

  const started = structuredContent(await context.client.callTool({
    name: "job_start",
    arguments: {
      workspace_id: first.workspace_id,
      operation_id: "job-rebind-start-0001",
      command: process.platform === "win32"
        ? "ping 127.0.0.1 -n 6 >NUL"
        : "sleep 5",
    },
  }));
  const startedJob = JSON.parse(String(started.result)) as { id: string };

  const listed = structuredContent(await context.client.callTool({
    name: "job_list",
    arguments: { workspace_id: second.workspace_id },
  }));
  const jobs = JSON.parse(String(listed.result)) as Array<{ id: string }>;
  assert.equal(jobs.some((job) => job.id === startedJob.id), true);

  const cancelled = structuredContent(await context.client.callTool({
    name: "job_cancel",
    arguments: {
      job_id: startedJob.id,
      operation_id: "job-rebind-cancel-0001",
    },
  }));
  const cancelResult = JSON.parse(String(cancelled.result)) as { success: boolean };
  assert.equal(cancelResult.success, true);
});

test("durable job_cancel operation_id safely replays an identical lost response", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const opened = structuredContent(
    await callOpen(context.client, context.project, "job-cancel-replay"),
  );
  const started = structuredContent(await context.client.callTool({
    name: "job_start",
    arguments: {
      workspace_id: opened.workspace_id,
      operation_id: "job-cancel-start-0001",
      command: process.platform === "win32"
        ? "ping 127.0.0.1 -n 61 >NUL"
        : "sleep 60",
    },
  }));
  const job = JSON.parse(String(started.result)) as { id: string };
  const request = {
    name: "job_cancel",
    arguments: {
      job_id: job.id,
      operation_id: "job-cancel-retry-0001",
    },
  };
  const first = structuredContent(await context.client.callTool(request));
  const replay = structuredContent(await context.client.callTool(request));
  assert.equal(first.operation_replayed, false);
  assert.equal(replay.operation_replayed, true);
  assert.equal(first.result, replay.result);
});

test("workflow evidence survives reconnect by canonical workspace root", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const first = structuredContent(
    await callOpen(context.client, context.project, "workflow-before"),
  );
  const second = structuredContent(
    await callOpen(context.client, context.project, "workflow-after"),
  );
  assert.notEqual(first.workspace_id, second.workspace_id);

  const startRequest = {
    name: "workflow_start",
    arguments: {
      workspace_id: first.workspace_id,
      operation_id: "workflow-start-retry-0001",
      task_intent: "Prove reconnect-safe workflow evidence.",
    },
  };
  const started = structuredContent(await context.client.callTool(startRequest));
  const startReplay = structuredContent(await context.client.callTool(startRequest));
  assert.equal(started.operation_replayed, false);
  assert.equal(startReplay.operation_replayed, true);
  assert.equal(started.result, startReplay.result);
  const workflow = JSON.parse(String(started.result)) as { id: string };

  const recordRequest = {
    name: "workflow_record",
    arguments: {
      workspace_id: second.workspace_id,
      workflow_id: workflow.id,
      operation_id: "workflow-record-retry-0001",
      validation_status: "pass",
      validation_summary: "Reconnected workspace can append validation evidence.",
      validation_run_id: "run_reconnect_workflow",
      review_ref: "refs/devspace/review/test",
    },
  };
  const recorded = structuredContent(await context.client.callTool(recordRequest));
  const recordReplay = structuredContent(await context.client.callTool(recordRequest));
  assert.equal(recorded.operation_replayed, false);
  assert.equal(recordReplay.operation_replayed, true);
  assert.equal(recorded.result, recordReplay.result);
  const recordedWorkflow = JSON.parse(String(recorded.result)) as {
    validation: Array<{ runId?: string }>;
    reviewRef?: string;
  };
  assert.equal(recordedWorkflow.validation.length, 1);
  assert.equal(recordedWorkflow.validation.at(-1)?.runId, "run_reconnect_workflow");
  assert.equal(recordedWorkflow.reviewRef, "refs/devspace/review/test");

  const finishRequest = {
    name: "workflow_finish",
    arguments: {
      workspace_id: second.workspace_id,
      workflow_id: workflow.id,
      operation_id: "workflow-finish-retry-0001",
      handoff_summary: "Reconnect-safe workflow evidence is complete.",
    },
  };
  const finished = structuredContent(await context.client.callTool(finishRequest));
  const finishReplay = structuredContent(await context.client.callTool(finishRequest));
  assert.equal(finished.operation_replayed, false);
  assert.equal(finishReplay.operation_replayed, true);
  assert.equal(finished.result, finishReplay.result);
  const finishedWorkflow = JSON.parse(String(finished.result)) as {
    status: string;
    handoffSummary?: string;
  };
  assert.equal(finishedWorkflow.status, "completed");
  assert.equal(
    finishedWorkflow.handoffSummary,
    "Reconnect-safe workflow evidence is complete.",
  );
});

test("model-facing tool schemas use snake_case recursively", async (t) => {
  for (const toolMode of ["claude", "codex"] as const) {
    await t.test(toolMode, async (nested) => {
      const context = await fixture(nested, { toolMode, uiEnabled: false });
      const tools = await context.client.listTools();
      const invalidPaths = tools.tools.flatMap((tool) => [
        ...schemaPropertyPaths(tool.inputSchema)
          .filter(({ key }) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))
          .map(({ path }) => `${tool.name}.input.${path}`),
        ...schemaPropertyPaths(tool.outputSchema)
          .filter(({ key }) => !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(key))
          .map(({ path }) => `${tool.name}.output.${path}`),
      ]);

      assert.deepEqual(invalidPaths, []);
    });
  }
});

test("Codex process tools bound model-facing yield windows to 12 seconds", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const tools = await context.client.listTools();

  for (const toolName of ["exec_command", "write_stdin"] as const) {
    const tool = tools.tools.find(({ name }) => name === toolName);
    const yieldSchema = tool?.inputSchema?.properties?.yield_time_ms as {
      maximum?: number;
      description?: string;
    } | undefined;

    assert.equal(yieldSchema?.maximum, 12_000);
    assert.match(yieldSchema?.description ?? "", /maximum 12000/i);
    if (toolName === "exec_command") {
      assert.match(yieldSchema?.description ?? "", /defaults to 3000/i);
    }
  }
});

test("Codex exposes Serena semantics directly and through the cached-tool compatibility command", async (t) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const semantic = new SerenaSemanticManager({
    available: true,
    createClient: async () => ({
      callTool: async ({ name, arguments: args }) => {
        calls.push({ tool: name, args: args ?? {} });
        return { structuredContent: { result: `semantic:${name}` } };
      },
      close: async () => undefined,
    }),
  });
  t.after(async () => semantic.close());
  const context = await fixture(t, {
    toolMode: "codex",
    uiEnabled: false,
    semantic,
  });
  const tools = await context.client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "semantic_code"));

  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "semantic-compat"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  const direct = structuredContent(await context.client.callTool({
    name: "semantic_code",
    arguments: {
      workspace_id: workspaceId,
      action: "overview",
      path: "src.ts",
    },
  }));
  assert.equal(direct.result, "semantic:get_symbols_overview");

  const compatibility = structuredContent(await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspace_id: workspaceId,
      cmd: "devspace-semantic find Example - info",
    },
  }));
  assert.equal(compatibility.result, "semantic:find_symbol");
  assert.deepEqual(calls.map((call) => call.tool), [
    "get_symbols_overview",
    "find_symbol",
  ]);
  assert.equal(calls[1]?.args.name_path_pattern, "Example");
  assert.equal(calls[1]?.args.relative_path, "");
  assert.equal(calls[1]?.args.include_info, true);

  const packed = structuredContent(await context.client.callTool({
    name: "context_pack",
    arguments: {
      workspace_id: workspaceId,
      path: "src.ts",
      depth: "focused",
      max_chars: 2_500,
    },
  }));
  assert.match(packed.result as string, /semantic:get_symbols_overview/);
  assert.equal(packed.semantic, true);

  const cachedCompatibility = structuredContent(await context.client.callTool({
    name: "exec_command",
    arguments: {
      workspace_id: workspaceId,
      cmd: "devspace-context src.ts - focused 2500",
    },
  }));
  assert.match(cachedCompatibility.result as string, /semantic:get_symbols_overview/);
  assert.deepEqual(calls.map((call) => call.tool), [
    "get_symbols_overview",
    "find_symbol",
    "get_symbols_overview",
    "get_symbols_overview",
  ]);
});

test("Claude edit and bash tools accept snake_case runtime inputs", async (t) => {
  const context = await fixture(t, { toolMode: "claude", uiEnabled: false });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "snake-case-claude"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "note.txt"), "before\n");
  await mkdir(join(context.project, "nested"));

  const edited = await context.client.callTool({
    name: "edit",
    arguments: {
      workspace_id: workspaceId,
      path: "note.txt",
      edits: [{ old_text: "before", new_text: "after" }],
    },
  });
  assert.equal(edited.isError, undefined);
  assert.equal(await readFile(join(context.project, "note.txt"), "utf8"), "after\n");

  const shell = structuredContent(await context.client.callTool({
    name: "bash",
    arguments: {
      workspace_id: workspaceId,
      command: "pwd",
      working_directory: "nested",
    },
  }));
  assert.match(shell.result as string, /nested/i);
});

test("read rejects a symlink that leaves the workspace", async (t) => {
  const context = await fixture(t, { toolMode: "claude", uiEnabled: false });
  const outside = await mkdtemp(join(tmpdir(), "devspace-server-outside-test-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.txt"), "outside secret\n");

  const outsideLink = join(context.project, "outside-link");
  await symlink(outside, outsideLink, platform() === "win32" ? "junction" : "dir");
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "symlink-read"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  const result = await context.client.callTool({
    name: "read",
    arguments: { workspace_id: workspaceId, path: "outside-link/secret.txt" },
  });
  assert.equal(result.isError, true);
});

test("read_image returns bounded MCP ImageContent without duplicating base64 in structured content", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  const image = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  await writeFile(join(context.project, "photo.png"), image);
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "read-image"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  const result = await context.client.callTool({
    name: "read_image",
    arguments: { workspace_id: workspaceId, path: "photo.png" },
  });
  assert.equal(result.isError, undefined);
  const content = result.content as Array<Record<string, unknown>>;
  assert.equal(content.length, 2);
  assert.equal(content[0]?.type, "text");
  assert.equal(content[1]?.type, "image");
  assert.equal(content[1]?.mimeType, "image/png");
  assert.equal(content[1]?.data, image.toString("base64"));

  const structured = structuredContent(result);
  assert.equal(structured.path, "photo.png");
  assert.equal(structured.mime_type, "image/png");
  assert.equal(structured.size_bytes, image.byteLength);
  assert.doesNotMatch(JSON.stringify(structured), new RegExp(image.toString("base64")));

  const tools = await context.client.listTools();
  const tool = tools.tools.find((item) => item.name === "read_image");
  assert.equal(tool?.annotations?.readOnlyHint, true);
  assert.equal((tool?._meta as { ui?: unknown } | undefined)?.ui, undefined);
});

test("read_image rejects unsupported, oversized, and symlink-escaped files", async (t) => {
  const context = await fixture(t, { toolMode: "claude", uiEnabled: false });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "read-image-safety"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "photo.gif"), "not an allowed image");
  const unsupported = await context.client.callTool({
    name: "read_image",
    arguments: { workspace_id: workspaceId, path: "photo.gif" },
  });
  assert.equal(unsupported.isError, true);

  const oversizedPath = join(context.project, "oversized.png");
  await writeFile(oversizedPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await truncate(oversizedPath, 20 * 1024 * 1024 + 1);
  const oversized = await context.client.callTool({
    name: "read_image",
    arguments: { workspace_id: workspaceId, path: "oversized.png" },
  });
  assert.equal(oversized.isError, true);

  const outside = await mkdtemp(join(tmpdir(), "devspace-image-outside-test-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await writeFile(
    join(outside, "outside.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  await symlink(outside, join(context.project, "outside-images"), platform() === "win32" ? "junction" : "dir");
  const escaped = await context.client.callTool({
    name: "read_image",
    arguments: { workspace_id: workspaceId, path: "outside-images/outside.png" },
  });
  assert.equal(escaped.isError, true);
});

test("read discovers nested instructions lazily once per conversation and bounds default output", async (t) => {
  const context = await fixture(t, { toolMode: "codex", uiEnabled: false });
  await mkdir(join(context.project, "nested"));
  await writeFile(join(context.project, "nested", "AGENTS.md"), "nested read rules\n");
  await writeFile(
    join(context.project, "nested", "large.ts"),
    Array.from(
      { length: 600 },
      (_, index) => `export const value_${index + 1} = "${"x".repeat(70)}";`,
    ).join("\n"),
  );
  const conversation = "lazy-read-context";
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, conversation),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  const callRead = () => context.client.callTool({
    name: "read",
    arguments: {
      workspace_id: workspaceId,
      path: "nested/large.ts",
    },
    _meta: { "openai/session": conversation },
  } as Parameters<Client["callTool"]>[0]);

  const first = structuredContent(await callRead());
  assert.match(first.result as string, /nested read rules/);
  assert.match(first.result as string, /value_1/);
  assert.doesNotMatch(first.result as string, /value_300/);
  assert.ok((first.result as string).length <= 32_000);
  assert.deepEqual(first.instruction_paths, ["nested/AGENTS.md"]);

  const second = structuredContent(await callRead());
  assert.doesNotMatch(second.result as string, /nested read rules/);
  assert.deepEqual(second.instruction_paths, ["nested/AGENTS.md"]);

  const tools = await context.client.listTools();
  const readTool = tools.tools.find((tool) => tool.name === "read");
  const limitSchema = readTool?.inputSchema?.properties?.limit as {
    maximum?: number;
    description?: string;
  } | undefined;
  assert.equal(limitSchema?.maximum, 2_000);
  assert.match(limitSchema?.description ?? "", /Defaults to 240/);
});

test("write rejects a new file through a symlink that leaves the workspace", async (t) => {
  const context = await fixture(t, { toolMode: "claude", uiEnabled: false });
  const outside = await mkdtemp(join(tmpdir(), "devspace-server-outside-test-"));
  t.after(async () => rm(outside, { recursive: true, force: true }));

  const outsideLink = join(context.project, "outside-link");
  await symlink(outside, outsideLink, platform() === "win32" ? "junction" : "dir");
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "symlink-write"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  const result = await context.client.callTool({
    name: "write",
    arguments: {
      workspace_id: workspaceId,
      path: "outside-link/new.txt",
      content: "escaped\n",
    },
  });
  assert.equal(result.isError, true);
  await assert.rejects(access(join(outside, "new.txt")));
});

test("UI metadata is limited to workspace and aggregate review", async (t) => {
  for (const uiEnabled of [true, false]) {
    await t.test(uiEnabled ? "enabled" : "disabled", async (nested) => {
      const context = await fixture(nested, { toolMode: "claude", uiEnabled });
      const tools = await context.client.listTools();
      const toolsWithUi = tools.tools
        .filter((tool) => Boolean((tool._meta as { ui?: unknown } | undefined)?.ui))
        .map((tool) => tool.name)
        .sort();

      assert.deepEqual(toolsWithUi, uiEnabled ? ["open_workspace", "show_changes"] : []);
    });
  }
});

test("open_workspace reports aggregate review availability", async (t) => {
  const plain = await fixture(t);
  const gitWorkspace = await fixture(t, { git: true });

  const plainReview = structuredContent(await callOpen(plain.client, plain.project, "plain")).review;
  const gitReview = structuredContent(await callOpen(gitWorkspace.client, gitWorkspace.project, "git")).review;

  assert.equal((plainReview as { available: boolean }).available, false);
  assert.deepEqual(gitReview, { available: true });
});

test("show_changes reviews an unborn repository through the MCP tool surface", async (t) => {
  const context = await fixture(t, { uiEnabled: false });
  await git(context.project, ["init"]);

  const opened = structuredContent(await callOpen(context.client, context.project, "unborn-review"));
  const workspaceId = opened.workspace_id;
  assert.equal(typeof workspaceId, "string");
  assert.deepEqual(opened.review, { available: true });

  await writeFile(join(context.project, "created-after-open.txt"), "new file\n");
  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  });
  const card = responseCard(review);

  assert.deepEqual(card.files, [
    {
      path: "created-after-open.txt",
      type: "new",
      additions: 1,
      removals: 0,
    },
  ]);
  assert.match(
    ((card.payload as { patch?: string } | undefined)?.patch) ?? "",
    /new file/,
  );
  await assert.rejects(() => execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: context.project,
  }));
});

test("show_changes keeps model output compact and preserves the rich review card", async (t) => {
  const context = await fixture(t, { git: true, uiEnabled: false });
  const opened = structuredContent(
    await callOpen(context.client, context.project, "review"),
  );
  const workspaceId = opened.workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "goodbye\n");
  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  });
  const structured = structuredContent(review);
  assert.equal((review._meta as Record<string, unknown> | undefined)?.tool, undefined);

  assert.equal(structured.workspace_id, workspaceId);
  assert.equal("workspaceId" in structured, false);
  assert.match(structured.review_ref as string, /^[0-9a-f]{40,64}$/);
  assert.equal("summary" in structured, false);
  assert.equal("files" in structured, false);
  assert.equal("patch" in structured, false);

  const card = responseCard(review);
  assert.deepEqual(card.summary, {
    files: 1,
    additions: 1,
    removals: 1,
  });
  assert.deepEqual(card.files, [
    {
      path: "README.md",
      type: "change",
      additions: 1,
      removals: 1,
    },
  ]);
  assert.match(
    ((card.payload as { patch?: string } | undefined)?.patch) ?? "",
    /-hello\n\+goodbye/,
  );

  const tools = await context.client.listTools();
  const outputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.outputSchema?.properties;
  assert.ok(outputProperties && "workspace_id" in outputProperties);
  assert.equal(outputProperties && "workspaceId" in outputProperties, false);
  assert.ok(outputProperties && "review_ref" in outputProperties);
  assert.equal(outputProperties && "summary" in outputProperties, false);
  assert.equal(outputProperties && "files" in outputProperties, false);
  assert.equal(outputProperties && "patch" in outputProperties, false);
  const inputProperties = tools.tools.find((tool) => tool.name === "show_changes")
    ?.inputSchema?.properties;
  assert.equal(inputProperties && "reviewRef" in inputProperties, false);
});

test("show_changes bounds oversized review card patches", async (t) => {
  const context = await fixture(t, { git: true, uiEnabled: false });
  const opened = structuredContent(
    await callOpen(context.client, context.project, "large-review"),
  );
  const workspaceId = opened.workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "large.txt"), "x".repeat(400_000));
  const review = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  });
  const card = responseCard(review);
  const patch = ((card.payload as { patch?: string } | undefined)?.patch) ?? "";

  assert.ok(patch.length < 300_000);
  assert.match(patch, /review patch truncated/);
});

test("show_changes can reopen a historical review without advancing the checkpoint", async (t) => {
  const context = await fixture(t, { git: true });
  const workspaceId = structuredContent(
    await callOpen(context.client, context.project, "review-history"),
  ).workspace_id;
  assert.equal(typeof workspaceId, "string");

  await writeFile(join(context.project, "README.md"), "first\n");
  const first = structuredContent(await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  }));
  const reviewRef = first.review_ref;
  assert.equal(typeof reviewRef, "string");

  await writeFile(join(context.project, "README.md"), "second\n");
  const reopened = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
    _meta: { "devspace/reviewRef": reviewRef },
  } as Parameters<Client["callTool"]>[0]);
  assert.equal(structuredContent(reopened).review_ref, reviewRef);
  assert.match(
    (((responseCard(reopened).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /\+first/,
  );

  const current = await context.client.callTool({
    name: "show_changes",
    arguments: { workspace_id: workspaceId },
  });
  assert.match(
    (((responseCard(current).payload as { patch?: string } | undefined)?.patch) ?? ""),
    /-first\n\+second/,
  );
});

test("open_workspace keeps lifecycle flags out of model output and preserves complete card metadata", async (t) => {
  const providerNote = "available";
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true, note: providerNote }],
  });
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  assert.equal((first._meta as Record<string, unknown> | undefined)?.tool, undefined);
  assert.equal((repeated._meta as Record<string, unknown> | undefined)?.tool, undefined);

  const tools = await context.client.listTools();
  const openTool = tools.tools.find((tool) => tool.name === "open_workspace");
  const outputProperties = (openTool?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  assert.ok(outputProperties && "workspace_id" in outputProperties);
  assert.equal(outputProperties && "workspaceId" in outputProperties, false);
  assert.equal(outputProperties && "workspaceReused" in outputProperties, false);
  assert.equal(outputProperties && "includeBootstrapContext" in outputProperties, false);
  const providerSchema = outputProperties?.agent_providers as {
    items?: { properties?: Record<string, unknown> };
  } | undefined;
  assert.ok(providerSchema?.items?.properties?.note);

  const firstStructured = structuredContent(first);
  assert.equal(typeof firstStructured.workspace_id, "string");
  assert.equal("workspaceId" in firstStructured, false);
  assert.equal(firstStructured.workspace_id, structuredContent(repeated).workspace_id);
  assert.ok(Array.isArray(firstStructured.agents_files));
  assert.ok(Array.isArray(firstStructured.available_agents_files));
  assert.ok(Array.isArray(firstStructured.skills));
  assert.ok(Array.isArray(firstStructured.agent_providers));
  assert.equal(
    (firstStructured.agent_providers as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (firstStructured.agent_providers as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(firstStructured.agents));
  assert.ok(Array.isArray(firstStructured.skill_diagnostics));
  assert.equal("workspaceReused" in firstStructured, false);
  assert.equal("includeBootstrapContext" in firstStructured, false);

  const repeatedStructured = structuredContent(repeated);
  assert.match(firstStructured.instruction as string, /workspace_id/);
  assert.match(repeatedStructured.instruction as string, /workspace_id/);
  assert.doesNotMatch(firstStructured.instruction as string, /workspaceId/);
  assert.doesNotMatch(repeatedStructured.instruction as string, /workspaceId/);
  assert.equal(repeatedStructured.agents_files, undefined);
  assert.equal(repeatedStructured.available_agents_files, undefined);
  assert.equal(repeatedStructured.skills, undefined);
  assert.equal(repeatedStructured.agent_providers, undefined);
  assert.equal(repeatedStructured.agents, undefined);
  assert.equal(repeatedStructured.skill_diagnostics, undefined);
  assert.equal("workspaceReused" in repeatedStructured, false);
  assert.equal("includeBootstrapContext" in repeatedStructured, false);

  const card = responseCard(repeated);
  assert.equal(card.workspaceReused, true);
  assert.equal(card.includeBootstrapContext, false);
  assert.ok(Array.isArray(card.agentsFiles));
  assert.ok(Array.isArray(card.availableAgentsFiles));
  assert.ok(Array.isArray(card.skills));
  assert.ok(Array.isArray(card.agentProviders));
  assert.equal(
    (card.agentProviders as Array<Record<string, unknown>>)[0]?.note,
    providerNote,
  );
  assert.ok(Array.isArray(card.agents));
});

test("open_workspace refreshes provider availability for each catalog", async (t) => {
  let available = false;
  const context = await fixture(t, {
    localAgentProviders: () => [{ name: "codex", available }],
  });

  const unavailable = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(unavailable.agent_providers, []);
  assert.deepEqual(unavailable.agents, []);

  available = true;
  const usable = structuredContent(await callOpen(context.client, context.project, "chat-2"));
  assert.equal(
    (usable.agent_providers as Array<Record<string, unknown>>)[0]?.id,
    "codex",
  );
  assert.equal(
    (usable.agents as Array<Record<string, unknown>>)[0]?.name,
    "reviewer",
  );
});

test("open_workspace omits providers disabled by configuration", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [
      { name: "codex", available: true },
      { name: "claude", available: true },
    ],
    subagents: {
      enabled: true,
      instructions: "on-demand",
      providers: [
        { id: "codex", enabled: true },
        { id: "claude", enabled: false },
      ],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  assert.deepEqual(
    (opened.agent_providers as Array<Record<string, unknown>>).map((provider) => provider.id),
    ["codex"],
  );
});

test("open_workspace advertises subagent instructions on demand by default", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const skills = opened.skills as Array<Record<string, unknown>>;
  assert.equal(skills.some((skill) => skill.name === "subagents"), true);
  assert.doesNotMatch(String(opened.instruction), /# DevSpace subagents/);
});

test("open_workspace preloads subagent instructions when configured", async (t) => {
  const context = await fixture(t, {
    localAgentProviders: [{ name: "codex", available: true }],
    subagents: {
      enabled: true,
      instructions: "preload",
      providers: [{ id: "codex", enabled: true }],
    },
  });

  const opened = structuredContent(await callOpen(context.client, context.project, "chat-1"));
  const skills = opened.skills as Array<Record<string, unknown>>;
  assert.equal(skills.some((skill) => skill.name === "subagents"), false);
  assert.match(String(opened.instruction), /# DevSpace subagents/);
});

test("open_workspace scopes checkout reuse to OpenAI session metadata", async (t) => {
  const context = await fixture(t);
  const first = await callOpen(context.client, context.project, "chat-1");
  const repeated = await callOpen(context.client, context.project, "chat-1");
  const otherSession = await callOpen(context.client, context.project, "chat-2");
  const unscoped = await callOpen(context.client, context.project);

  assert.equal(structuredContent(repeated).workspace_id, structuredContent(first).workspace_id);
  assert.equal(structuredContent(repeated).agents_files, undefined);
  assert.notEqual(structuredContent(otherSession).workspace_id, structuredContent(first).workspace_id);
  assert.notEqual(structuredContent(unscoped).workspace_id, structuredContent(first).workspace_id);
  assert.ok(Array.isArray(structuredContent(otherSession).agents_files));
  assert.ok(Array.isArray(structuredContent(unscoped).agents_files));
});

test("Express auth middleware lifecycle settles once and releases listeners", async (t) => {
  await t.test("next continues the request", async () => {
    const exchange = fakeMiddlewareExchange();
    const completion = await waitForExpressMiddleware(
      ((_req, _res, next) => next()) as RequestHandler,
      exchange.req,
      exchange.res,
    );

    assert.equal(completion, "next");
    exchange.assertNoLifecycleListeners();
  });

  for (const status of [400, 401, 403]) {
    await t.test(`direct ${status} response completes without next`, async () => {
      const exchange = fakeMiddlewareExchange();
      const completion = await waitForExpressMiddleware(
        ((_req, res) => res.status(status).end()) as RequestHandler,
        exchange.req,
        exchange.res,
      );

      assert.equal(completion, "response");
      assert.equal(exchange.statusCode(), status);
      exchange.assertNoLifecycleListeners();
    });
  }

  await t.test("finish and close cannot settle twice", async () => {
    const exchange = fakeMiddlewareExchange();
    let settlements = 0;
    const completion = waitForExpressMiddleware(
      (() => undefined) as RequestHandler,
      exchange.req,
      exchange.res,
    ).then((result) => {
      settlements += 1;
      return result;
    });

    exchange.responseEvents.emit("finish");
    exchange.responseEvents.emit("close");

    assert.equal(await completion, "response");
    assert.equal(settlements, 1);
    exchange.assertNoLifecycleListeners();
  });

  await t.test("request abort does not affect the next request", async () => {
    const aborted = fakeMiddlewareExchange();
    const abortedCompletion = waitForExpressMiddleware(
      (() => undefined) as RequestHandler,
      aborted.req,
      aborted.res,
    );
    aborted.requestEvents.emit("aborted");
    assert.equal(await abortedCompletion, "response");
    aborted.assertNoLifecycleListeners();

    const nextRequest = fakeMiddlewareExchange();
    assert.equal(
      await waitForExpressMiddleware(
        ((_req, _res, next) => next()) as RequestHandler,
        nextRequest.req,
        nextRequest.res,
      ),
      "next",
    );
    nextRequest.assertNoLifecycleListeners();
  });
});

test("HTTP endpoint serves modern MCP and stateless legacy clients", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(
    t,
    "devspace-modern-http-test-",
  );

  const unauthenticated = await postModernMcp(
    localBaseUrl,
    undefined,
    "tools/list",
    {},
  );
  assert.equal(unauthenticated.status, 401, await unauthenticated.clone().text());

  const discovery = await postModernMcp(
    localBaseUrl,
    accessToken,
    "server/discover",
    {},
  );
  assert.equal(discovery.status, 200, await discovery.clone().text());
  const discoveryBody = await discovery.json() as {
    result?: { supportedVersions?: string[] };
  };
  assert.ok(discoveryBody.result?.supportedVersions?.includes("2026-07-28"));

  const listed = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/list",
    {},
  );
  assert.equal(listed.status, 200, await listed.clone().text());
  const listBody = await listed.json() as {
    result?: { tools?: Array<{ name?: string }> };
  };
  assert.ok(listBody.result?.tools?.some((tool) => tool.name === "open_workspace"));

  const called = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "modern-http-test" },
    },
  );
  assert.equal(called.status, 200, await called.clone().text());
  const callBody = await called.json() as {
    result?: { structuredContent?: { workspace_id?: string; agents_files?: unknown[] } };
  };
  const workspaceId = callBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const repeated = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "modern-http-test" },
    },
  );
  assert.equal(repeated.status, 200, await repeated.clone().text());
  const repeatedBody = await repeated.json() as {
    result?: { structuredContent?: { workspace_id?: string; agents_files?: unknown[] } };
  };
  assert.equal(repeatedBody.result?.structuredContent?.workspace_id, workspaceId);
  assert.equal(repeatedBody.result?.structuredContent?.agents_files, undefined);

  const closedNotification = await postModernMcpNotification(
    localBaseUrl,
    accessToken,
    "notifications/initialized",
    { connection: "close" },
  );
  assert.equal(closedNotification.status, 202, await closedNotification.clone().text());

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const sequential = await postModernMcp(
      localBaseUrl,
      accessToken,
      "tools/list",
      {},
    );
    assert.equal(
      sequential.status,
      200,
      `sequential request ${attempt + 1}: ${await sequential.clone().text()}`,
    );
  }

  const legacy = await fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "legacy-initialize",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "devspace-legacy-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(legacy.status, 200, await legacy.clone().text());
  assert.equal(legacy.headers.get("mcp-session-id"), null);
  assert.match(await legacy.text(), /"protocolVersion"/);

  const legacyTools = await fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "legacy-tools-list",
      method: "tools/list",
      params: {},
    }),
  });
  assert.equal(legacyTools.status, 200, await legacyTools.clone().text());
  assert.equal(legacyTools.headers.get("mcp-session-id"), null);
  assert.match(await legacyTools.text(), /"open_workspace"/);
});

test("server shutdown waits for an active MCP tool call", async (t) => {
  const { root, localBaseUrl, accessToken, running } = await httpServerFixture(
    t,
    "devspace-shutdown-test-",
  );
  const opened = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "shutdown-test" },
    },
  );
  const openBody = await opened.json() as {
    result?: { structuredContent?: { workspace_id?: string } };
  };
  const workspaceId = openBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const command = [
    "const fs=require('node:fs')",
    "fs.writeFileSync('started','')",
    "const timer=setInterval(()=>{if(fs.existsSync('release')) clearInterval(timer)},10)",
  ].join(";");
  const toolCall = postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "exec_command",
      arguments: {
        workspace_id: workspaceId,
        cmd: `node -e \"${command}\"`,
        yield_time_ms: 12_000,
      },
    },
  );
  await waitForFile(join(root, "started"));

  let shutdownFinished = false;
  const shutdown = running.close().then(() => {
    shutdownFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(shutdownFinished, false);

  await writeFile(join(root, "release"), "");
  await toolCall;
  await shutdown;
  assert.equal(shutdownFinished, true);
});

test("a long MCP tool call does not poison the next request", async (t) => {
  const { root, localBaseUrl, accessToken } = await httpServerFixture(
    t,
    "devspace-long-call-test-",
  );
  const opened = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "open_workspace",
      arguments: { path: root },
      _meta: { "openai/session": "long-call-test" },
    },
  );
  const openBody = await opened.json() as {
    result?: { structuredContent?: { workspace_id?: string } };
  };
  const workspaceId = openBody.result?.structuredContent?.workspace_id;
  assert.equal(typeof workspaceId, "string");

  const command = [
    "const fs=require('node:fs')",
    "fs.writeFileSync('started','')",
    "const timer=setInterval(()=>{if(fs.existsSync('release')) clearInterval(timer)},10)",
  ].join(";");
  let toolCallFinished = false;
  const toolCall = postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/call",
    {
      name: "exec_command",
      arguments: {
        workspace_id: workspaceId,
        cmd: `node -e \"${command}\"`,
        yield_time_ms: 12_000,
      },
    },
  ).then((response) => {
    toolCallFinished = true;
    return response;
  });
  await waitForFile(join(root, "started"));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(toolCallFinished, false);

  await writeFile(join(root, "release"), "");
  const toolResponse = await toolCall;
  assert.equal(toolResponse.status, 200, await toolResponse.clone().text());

  const subsequent = await postModernMcp(
    localBaseUrl,
    accessToken,
    "tools/list",
    {},
  );
  assert.equal(subsequent.status, 200, await subsequent.clone().text());
});

interface ServerFixture {
  client: Client;
  project: string;
}

function schemaPropertyPaths(
  schema: unknown,
  prefix = "",
): Array<{ key: string; path: string }> {
  if (!schema || typeof schema !== "object") return [];
  const record = schema as {
    properties?: Record<string, unknown>;
    items?: unknown;
    anyOf?: unknown[];
    oneOf?: unknown[];
    allOf?: unknown[];
  };
  const paths = Object.entries(record.properties ?? {}).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [{ key, path }, ...schemaPropertyPaths(child, path)];
  });
  if (record.items) paths.push(...schemaPropertyPaths(record.items, `${prefix}[]`));
  for (const variant of [record.anyOf, record.oneOf, record.allOf]) {
    for (const child of variant ?? []) {
      paths.push(...schemaPropertyPaths(child, prefix));
    }
  }
  return paths;
}

interface HttpServerFixture {
  root: string;
  localBaseUrl: string;
  accessToken: string;
  running: ReturnType<typeof createServer>;
}

async function httpServerFixture(
  t: TestContext,
  prefix: string,
  lifecycleLogging = false,
): Promise<HttpServerFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const ownerToken = "test-owner-token-that-is-long-enough";
  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: {
      port: 1,
      publicBaseUrl: "https://example.test",
    },
    workspaces: {
      allowedRoots: [root],
      worktreeRoot: join(root, ".worktrees"),
    },
    storage: { stateDir: join(root, ".state") },
  }));
  if (lifecycleLogging) {
    config.logging.level = "debug";
    config.logging.format = "json";
    config.logging.requests = true;
  }
  const running = createServer(config, { incomingArtifactAdapters: [] });
  const httpServer = running.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => httpServer.once("listening", resolve));

  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    await running.close();
    await rm(root, { recursive: true, force: true });
  });

  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const localBaseUrl = `http://127.0.0.1:${address.port}`;
  const accessToken = await issueTestAccessToken(
    localBaseUrl,
    config.publicBaseUrl,
    ownerToken,
  );
  return { root, localBaseUrl, accessToken, running };
}

async function fixture(
  t: TestContext,
  options: {
    git?: boolean;
    localAgentProviders?: LocalAgentProviderAvailability[] | (() => LocalAgentProviderAvailability[]);
    subagents?: SubagentsConfig;
    toolMode?: ToolMode;
    uiEnabled?: boolean;
    semantic?: SerenaSemanticManager;
  } = {},
): Promise<ServerFixture> {
  const root = await mkdtemp(join(tmpdir(), "devspace-server-test-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const stateDir = join(root, ".state");

  await mkdir(join(project, ".devspace", "agents"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "global instructions\n");
  await writeFile(join(project, "AGENTS.md"), "project instructions\n");
  await writeFile(join(project, ".devspace", "agents", "reviewer.md"), [
    "---",
    "name: reviewer",
    "description: Reviews project changes.",
    "provider: codex",
    "---",
    "Review changes.",
  ].join("\n"));

  if (options.git) {
    await writeFile(join(project, "README.md"), "hello\n");
    await git(project, ["init"]);
    await git(project, ["config", "user.email", "devspace@example.com"]);
    await git(project, ["config", "user.name", "DevSpace Test"]);
    await git(project, ["add", "."]);
    await git(project, ["commit", "-m", "Initial commit"]);
  }

  const initialProviderAvailability = typeof options.localAgentProviders === "function"
    ? options.localAgentProviders()
    : options.localAgentProviders ?? [];
  const loadedConfig = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
    skills: { agentDir },
    subagents: {
      enabled: options.localAgentProviders !== undefined,
      instructions: "on-demand",
      providers: [],
    },
  }));
  const modeConfig: ServerConfig = {
    ...loadedConfig,
    toolMode: options.toolMode ?? loadedConfig.toolMode,
    uiEnabled: options.uiEnabled ?? loadedConfig.uiEnabled,
  };
  const config: ServerConfig = options.localAgentProviders
    ? {
        ...modeConfig,
        subagents: options.subagents ?? {
          enabled: true,
          instructions: "on-demand",
          providers: initialProviderAvailability.map((provider) => ({
            id: provider.name,
            enabled: true,
          })),
        },
      }
    : modeConfig;
  const resolveProviderAvailability: () => LocalAgentProviderAvailability[] =
    typeof options.localAgentProviders === "function"
      ? options.localAgentProviders
      : () => initialProviderAvailability;
  const resolveLocalAgentProviders = () => buildLocalAgentProviderStatuses(
    config.subagents,
    resolveProviderAvailability(),
  );
  const store = new SqliteWorkspaceStore(stateDir);
  const workspaces = new WorkspaceRegistry(config, store);
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    new ProcessSessionManager(),
    resolveLocalAgentProviders,
    [],
    undefined,
    options.semantic,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "devspace-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
    closeDurableJobManager(config.stateDir);
    closeWorkflowSessionManager(config.stateDir);
    closeOperationReceiptManager(config.stateDir);
    store.close();
  };

  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });

  return { client, project };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.fail(`Timed out waiting for ${path}`);
}

async function issueTestAccessToken(
  localBaseUrl: string,
  publicBaseUrl: string,
  ownerToken: string,
): Promise<string> {
  const redirectUri = "http://127.0.0.1/callback";
  const publicUrl = new URL(publicBaseUrl);
  const basePath = publicUrl.pathname.replace(/\/+$/, "");
  const localOAuthBase = `${localBaseUrl}${basePath === "/" ? "" : basePath}`;
  publicUrl.pathname = `${basePath === "/" ? "" : basePath}/mcp`;
  const resource = publicUrl.href;
  const verifier = "devspace-modern-protocol-test-verifier-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const registration = await fetch(`${localOAuthBase}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "DevSpace modern protocol test",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const client = await registration.json() as { client_id?: string };
  assert.ok(client.client_id);

  const approval = await fetch(`${localOAuthBase}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "devspace",
      resource,
      state: "modern-test",
      owner_token: ownerToken,
    }),
    redirect: "manual",
  });
  assert.equal(approval.status, 302, await approval.clone().text());
  const location = approval.headers.get("location");
  assert.ok(location);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);

  const exchange = await fetch(`${localOAuthBase}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const tokens = await exchange.json() as { access_token?: string };
  assert.ok(tokens.access_token);
  return tokens.access_token;
}

function postModernMcp(
  localBaseUrl: string,
  accessToken: string | undefined,
  method: string,
  params: Record<string, unknown>,
  options: { signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<Response> {
  const mcpName = typeof params.name === "string"
    ? params.name
    : typeof params.uri === "string"
      ? params.uri
      : undefined;
  return fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...(mcpName ? { "mcp-name": mcpName } : {}),
      ...options.headers,
    },
    signal: options.signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `modern-${method}`,
      method,
      params: {
        ...params,
        _meta: {
          ...recordValue(params._meta),
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "devspace-modern-http-test",
            version: "1.0.0",
          },
        },
      },
    }),
  });
}

function postModernMcpNotification(
  localBaseUrl: string,
  accessToken: string,
  method: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${localBaseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "devspace-modern-http-test",
            version: "1.0.0",
          },
        },
      },
    }),
  });
}

function fakeMiddlewareExchange(): {
  req: Request;
  res: ExpressResponse;
  requestEvents: EventEmitter;
  responseEvents: EventEmitter;
  statusCode(): number;
  assertNoLifecycleListeners(): void;
} {
  const requestEvents = new EventEmitter();
  const responseEvents = new EventEmitter();
  let statusCode = 200;
  const response = Object.assign(responseEvents, {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    status(status: number) {
      statusCode = status;
      return this;
    },
    end() {
      this.headersSent = true;
      this.writableEnded = true;
      responseEvents.emit("finish");
      responseEvents.emit("close");
      return this;
    },
  });
  const lifecycleEvents = ["finish", "close", "error"];
  const requestLifecycleEvents = ["aborted", "error"];

  return {
    req: requestEvents as unknown as Request,
    res: response as unknown as ExpressResponse,
    requestEvents,
    responseEvents,
    statusCode: () => statusCode,
    assertNoLifecycleListeners: () => {
      for (const event of lifecycleEvents) {
        assert.equal(responseEvents.listenerCount(event), 0, `response ${event} listener leaked`);
      }
      for (const event of requestLifecycleEvents) {
        assert.equal(requestEvents.listenerCount(event), 0, `request ${event} listener leaked`);
      }
    },
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function callOpen(
  client: Client,
  path: string,
  conversationScopeId?: string,
): Promise<Awaited<ReturnType<Client["callTool"]>>> {
  const params = {
    name: "open_workspace",
    arguments: { path },
    ...(conversationScopeId
      ? { _meta: { "openai/session": conversationScopeId } }
      : {}),
  } as Parameters<Client["callTool"]>[0];
  return client.callTool(params);
}

function structuredContent(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function responseCard(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const metadata = result._meta;
  assert.ok(metadata && typeof metadata === "object");
  const card = (metadata as Record<string, unknown>).card;
  assert.ok(card && typeof card === "object");
  return card as Record<string, unknown>;
}
