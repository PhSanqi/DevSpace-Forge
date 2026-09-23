/** Origin-side observations only: edge arrival and client receipt require edge/client evidence. */
export interface RequestLifecycle {
  handlerStartedAt?: number;
  handlerCompletedAt?: number;
  responseStartedAt?: number;
  toolStartedCount: number;
  toolResolvedCount: number;
  toolRejectedCount: number;
  activeToolCount: number;
}

export type RequestDisconnectPhase =
  | "before_mcp_handler"
  | "while_tool_running_before_response"
  | "after_tool_resolution_before_response"
  | "after_tool_rejection_before_response"
  | "mcp_handler_running_before_response"
  | "mcp_handler_completed_before_response"
  | "after_response_start";

export function requestDisconnectPhase(lifecycle: RequestLifecycle): RequestDisconnectPhase {
  if (lifecycle.responseStartedAt !== undefined) return "after_response_start";
  if (lifecycle.activeToolCount > 0) return "while_tool_running_before_response";
  if (lifecycle.toolRejectedCount > 0) return "after_tool_rejection_before_response";
  if (lifecycle.toolResolvedCount > 0) return "after_tool_resolution_before_response";
  if (lifecycle.handlerCompletedAt !== undefined) return "mcp_handler_completed_before_response";
  if (lifecycle.handlerStartedAt !== undefined) return "mcp_handler_running_before_response";
  return "before_mcp_handler";
}

export function originRequestTimingFields(
  lifecycle: RequestLifecycle,
  requestStartedAt: number,
  observedAt: number,
): Record<string, string | number | boolean | undefined> {
  const responseStartMs = lifecycle.responseStartedAt === undefined
    ? undefined
    : Math.max(0, Math.round(lifecycle.responseStartedAt - requestStartedAt));
  return {
    durationMs: Math.max(0, Math.round(observedAt - requestStartedAt)),
    // Compatibility: firstByteMs has historically meant the origin writeHead boundary.
    firstByteMs: responseStartMs,
    first_byte_ms: responseStartMs,
    responseStartMs,
    response_start_ms: responseStartMs,
    firstByteObservation: "origin_write_head_not_client_receipt",
    transportEstablished: true,
    transport_established: true,
    transportScope: "origin_http_request_received",
    responseStarted: lifecycle.responseStartedAt !== undefined,
    handlerStarted: lifecycle.handlerStartedAt !== undefined,
    handlerCompleted: lifecycle.handlerCompletedAt !== undefined,
    handlerStartMs: lifecycle.handlerStartedAt === undefined
      ? undefined : Math.max(0, Math.round(lifecycle.handlerStartedAt - requestStartedAt)),
    handlerCompleteMs: lifecycle.handlerCompletedAt === undefined
      ? undefined : Math.max(0, Math.round(lifecycle.handlerCompletedAt - requestStartedAt)),
    toolStartedCount: lifecycle.toolStartedCount,
    toolResolvedCount: lifecycle.toolResolvedCount,
    toolRejectedCount: lifecycle.toolRejectedCount,
    activeToolCount: lifecycle.activeToolCount,
  };
}
