# Request lifecycle diagnostics (origin scope)

DevSpace emits structured `http_request_start`, `http_response_start`, `http_request`,
`http_request_aborted`, `mcp_request_complete`, and `mcp_request_error` events. Use
their common origin-generated `requestId` to reconstruct one HTTP request. The
optional `cfRay` field is a correlation hint for Cloudflare logs, not an
authentication identity or proof of delivery.

The timing fields use one monotonic origin clock. `transport_established=true`
means the origin HTTP handler **received a request**; it says nothing about a
successful Cloudflare-to-client connection. `response_start_ms` and the
backwards-compatible `firstByteMs` (plus `first_byte_ms`) observe the first
origin `writeHead`, **not** the moment a byte reaches the client. Their explicit
`firstByteObservation=origin_write_head_not_client_receipt` prevents equating
these values with end-to-end TTFB.

| Evidence | Interpretation |
| --- | --- |
| Edge request exists but no matching origin request/cfRay | Not observed at origin; compare edge/Tunnel logs. Absence alone is not proof of where it failed. |
| `http_request_start` / `transport_established=true` | Request reached the DevSpace origin HTTP handler. |
| `activeToolCount>0` on `http_request_aborted` | Origin connection closed while a tracked tool was running. |
| `toolResolvedCount>0`, `responseStarted=false` on abort | A tracked tool handler resolved (possibly with an `isError` result), but the origin had not emitted response headers. |
| `handlerCompleted=true`, `responseStarted=false` on abort | MCP HTTP handler settled before response emission; do not assume a tool completed if counts are zero. |
| `responseStarted=true` on abort | Origin emitted response headers, but the connection closed before response `finish`. This does not prove client receipt. |
| `http_request` with `outcome=response_finished` | Origin finished its response; client delivery still requires edge/client evidence. |

`disconnectPhase` is an origin-side classification, not a claim about the cause
of a client or connector failure. Tool counters are scoped to an MCP request
through async context; zero tool observations must not be interpreted as proof
that an external tool ran or did not run. No request body, token, or command
contents are added to lifecycle logs. Compare origin events against the
dedicated Tunnel metrics and Cloudflare edge timestamps when investigating
requests that never reached the origin.
