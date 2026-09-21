# Roadmap

## Phase A — Canonical source and runtime — Completed 2026-09-21

- Canonical ControlPlatform source is `main`.
- Canonical DevSpace runtime source is `runtime/beta4-unified`.
- Canonical runtime release is `1.1.0-beta.4.local.12`.
- Server runs local.12. Group has a validated local.12 slot ready but remains
  on local.11 until its currently offline public Tunnel recovers and the live
  switch can be independently verified.
- Group cloudflared is 2026.9.1.
- Legacy Linux 7676/8787 control service is stopped and disabled; rollback
  material remains available without participating in the live path.
- Both public MCP/OAuth paths were verified after convergence and again after
  legacy shutdown, including repeated and long-running tool calls.

## Phase B — Durable Jobs — Implemented 2026-09-21

local.12 evolves the compact run_id base into a first-class durable Job:

- stable job_id across the request boundary;
- process continues without keeping one MCP request open;
- bounded status/tail/grep/byte-range evidence;
- cancellation with explicit ownership/authority checks;
- queued/running/exited/cancelled terminal states;
- bounded retention.

It also adds persisted recoverable mutation receipts via `operation_id` and
reconnect-safe Job discovery by canonical workspace root. This borrows the
useful part of WebCodex Jobs without introducing a central Runner service.

Operational follow-up: Group must still switch from local.11 to its prepared
local.12 slot after the Group Tunnel recovers.

## Phase C — Workflow Session evidence

Status: not complete. Existing process/workspace session state is reusable
infrastructure, but there is no bounded canonical Workflow Session record yet.

Add a bounded task/session record above workspaces:

- task intent and workspace/worktree identity;
- validation evidence;
- review reference;
- concise handoff/resume summary;
- no authentication authority encoded in session IDs.

The host remains the orchestrator.

## Phase D — Managed worktree lifecycle

Status: partially present. Managed create/reuse and stale pruning exist; the
explicit finish/hygiene contract remains open.

- explicit create/reuse/finish/prune lifecycle;
- hygiene checks before finishing;
- protection for unrelated dirty changes;
- deterministic project identity and ownership.

## Phase E — Structured validation and finish

Status: not complete.

- language-aware validation recipes;
- one structured finish operation that reports validation + review evidence;
- shell remains available as an escape hatch, not the default for routine
  validation.

## Phase F — Runtime Console — Core implemented 2026-09-21

Windows Control Platform and Linux now have a read-only Runtime Console that
reports instance/runtime identity, Tunnel/readiness state, durable Jobs,
workspace sessions and recent MCP/request diagnostics without revealing
credentials.

Expose one management surface for:

- instance and Tunnel readiness;
- current workspaces/worktrees;
- durable Jobs and bounded output;
- Workflow Sessions and recent activity;
- runtime/update state;
- diagnostics and safe restart.

The Workflow Session portion remains blocked on Phase C rather than requiring a
second console architecture. Credentials are never returned by general status
APIs. Local credential reveal must remain an explicit local-only action.

## Immediate operational follow-up

1. Recover the Windows Group Cloudflare Tunnel (currently HTTP 530).
2. Switch Group to the already prepared `windows-beta4-local12` slot.
3. Deploy the current Control Platform build containing Runtime Console.
4. Re-run Group local/public readiness and MCP smoke after the switch.
5. Once both platforms are verified on local.12, update Current Truth and cut
   the next release package/tag.

## Deferred

- centralized multi-machine Server/Runner orchestration;
- multi-tenant project grants;
- QUIC runner enrollment;
- a second subagent manager;
- wholesale installation of WebCodex or DevSpace Verge.

These are only justified by a concrete future requirement.
