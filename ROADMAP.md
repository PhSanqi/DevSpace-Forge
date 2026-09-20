# Roadmap

## Phase A — Canonical source and runtime

- Collapse the old Windows master and release/main history into one canonical
  branch.
- Build Group and Server from one ControlPlatform source.
- Build Windows and Linux DevSpace packages from one beta4 local runtime source.
- Upgrade Group cloudflared to 2026.9.1.
- Verify both public MCP/OAuth paths after deployment.

## Phase B — Durable Jobs

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

Add a bounded task/session record above workspaces:

- task intent and workspace/worktree identity;
- validation evidence;
- review reference;
- concise handoff/resume summary;
- no authentication authority encoded in session IDs.

The host remains the orchestrator.

## Phase D — Managed worktree lifecycle

- explicit create/reuse/finish/prune lifecycle;
- hygiene checks before finishing;
- protection for unrelated dirty changes;
- deterministic project identity and ownership.

## Phase E — Structured validation and finish

- language-aware validation recipes;
- one structured finish operation that reports validation + review evidence;
- shell remains available as an escape hatch, not the default for routine
  validation.

## Phase F — Runtime Console

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
