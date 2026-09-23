# Large payload transport

DevSpace uses a workspace-scoped payload spool for tool arguments that are too
large for one MCP request. The upload contract is `payload_begin` → one or more
`payload_chunk` calls → `payload_commit`. Consumers accept the resulting
immutable `payload_ref`; uncommitted chunks are never executed or interpreted
as a command or patch.

The default decoded chunk size is **48 KiB**. On the production
ChatGPT → Cloudflare → DevSpace Server path measured on 2026-09-23, an inline
`apply_patch` request carrying roughly 96 KiB of patch text succeeded, while
roughly 112 KiB and larger requests returned HTTP `413 Payload Too Large` from
`https://dev.sanqi.org/server/mcp`. Base64 expands a 48 KiB decoded chunk to
65,536 characters, leaving room for JSON-RPC, tool metadata, IDs, hashes, and
headers below the observed request ceiling. The value is intentionally
conservative rather than tuned to the largest request that happened to pass.

Each upload declares its total byte length and full SHA-256. Each chunk has a
zero-based sequence and its own SHA-256. Duplicate identical chunks are
idempotent; a conflicting chunk fails closed. `payload_status` reports received
and missing sequences so an interrupted upload can resume. Commit assembles the
chunks atomically, verifies byte length and the full digest, then seals the
payload. Payloads are scoped to the workspace, bounded by per-payload and
per-workspace quotas, and expire under the spool TTL.

`payload_read` progressively exposes a committed payload with bounded
`offset`/`length` reads. For command output, DevSpace continues to use the
existing compact run-log mechanism: the MCP response returns a bounded preview
and `run_id`, and the full local log can be read or searched in slices. This
avoids creating a second output-log subsystem merely for large payloads.

Current payload consumers include `exec_command` and `apply_patch`. Each
consumer requires exactly one inline argument or `payload_ref`, and verifies
that the referenced payload is committed UTF-8 text before use.
