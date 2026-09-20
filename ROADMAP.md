# Roadmap

## Phase A — Canonical source and runtime — Completed 2026-09-21

- Canonical ControlPlatform source is `main`.
- Canonical DevSpace runtime source is `runtime/beta4-unified`.
- Group and Server both run packaged `1.1.0-beta.4.local.11` from that runtime
  line rather than divergent per-machine source copies.
- Group cloudflared is 2026.9.1.
- Legacy Linux 7676/8787 control service is stopped and disabled; rollback
  material remains available without participating in the live path.
- Both public MCP/OAuth paths were verified after convergence and again after
  legacy shutdown, including repeated and long-running tool calls.

## Phase B — Durable Jobs

Status: not complete. Existing `run_id` plus bounded log storage is the base,
not yet a first-class durable Job contract.

Evolve the existing compact run_id implementation into a first-class Job:

- stable job_id across the request boundary;
- process continues without keeping one MCP request open;
- bounded status/tail/grep/byte-range evidence;
- cancellation with explicit ownership/authority checks;
- queued/running/exited/cancelled terminal states;
- bounded retention.

This borrows the useful part of WebCodex Jobs without introducing a central
Runner service.

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

## Phase F — Runtime Console

Status: partially present. Current management/readiness surfaces cover instance
and runtime status, but first-class Jobs and Workflow Sessions do not yet exist.

Expose one management surface for:

- instance and Tunnel readiness;
- current workspaces/worktrees;
- durable Jobs and bounded output;
- Workflow Sessions and recent activity;
- runtime/update state;
- diagnostics and safe restart.

Credentials are never returned by general status APIs. Local credential reveal
must remain an explicit local-only action.

## Deferred

- centralized multi-machine Server/Runner orchestration;
- multi-tenant project grants;
- QUIC runner enrollment;
- a second subagent manager;
- wholesale installation of WebCodex or DevSpace Verge.

These are only justified by a concrete future requirement.
