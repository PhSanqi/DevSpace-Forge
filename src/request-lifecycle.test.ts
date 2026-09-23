import assert from "node:assert/strict";
import test from "node:test";
import {
  originRequestTimingFields,
  requestDisconnectPhase,
  type RequestLifecycle,
} from "./request-lifecycle.js";

const initial = (): RequestLifecycle => ({
  toolStartedCount: 0,
  toolResolvedCount: 0,
  toolRejectedCount: 0,
  activeToolCount: 0,
});

test("origin lifecycle classifies disconnects without inventing upstream evidence", () => {
  assert.equal(requestDisconnectPhase(initial()), "before_mcp_handler");
  assert.equal(requestDisconnectPhase({ ...initial(), handlerStartedAt: 100 }), "mcp_handler_running_before_response");
  assert.equal(requestDisconnectPhase({ ...initial(), handlerStartedAt: 100, handlerCompletedAt: 200 }), "mcp_handler_completed_before_response");
  assert.equal(requestDisconnectPhase({ ...initial(), handlerStartedAt: 100, activeToolCount: 1 }), "while_tool_running_before_response");
  assert.equal(requestDisconnectPhase({ ...initial(), toolResolvedCount: 1 }), "after_tool_resolution_before_response");
  assert.equal(requestDisconnectPhase({ ...initial(), toolRejectedCount: 1 }), "after_tool_rejection_before_response");
  assert.equal(requestDisconnectPhase({ ...initial(), responseStartedAt: 150, activeToolCount: 1 }), "after_response_start");
});

test("origin timing distinguishes response emission from client receipt", () => {
  const fields = originRequestTimingFields({
    ...initial(),
    handlerStartedAt: 110,
    handlerCompletedAt: 140,
    responseStartedAt: 145,
    toolStartedCount: 1,
    toolResolvedCount: 1,
  }, 100, 160);
  assert.equal(fields.first_byte_ms, 45);
  assert.equal(fields.response_start_ms, 45);
  assert.equal(fields.firstByteMs, 45);
  assert.equal(fields.firstByteObservation, "origin_write_head_not_client_receipt");
  assert.equal(fields.transport_established, true);
  assert.equal(fields.handlerCompleteMs, 40);
  assert.equal(fields.toolResolvedCount, 1);

  const beforeStart = originRequestTimingFields(initial(), 100, 130);
  assert.equal(beforeStart.first_byte_ms, undefined);
  assert.equal(beforeStart.responseStarted, false);
  assert.equal(beforeStart.handlerCompleted, false);
});
