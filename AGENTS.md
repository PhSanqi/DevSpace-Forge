# DevSpace execution platform

## Goal

Maintain one cross-platform execution platform around DevSpace: secure remote MCP
access, reproducible runtime packaging, lifecycle supervision, review/evidence,
durable execution, semantic context, and platform-specific control surfaces.

## Hard boundaries

- Group and Server production instances are already migrated to instance-scoped
  paths. Do not reintroduce the retired QuickConfig/7676/8787 architecture.
- Keep runtime, config, state, and credentials instance-scoped. Never log or
  commit plaintext owner passwords or Tunnel tokens.
- DevSpace subagents remain disabled. Do not add a second subagent manager or enable local harness delegation as part of the current roadmap.
- Upstream DevSpace and DevSpace Verge are input lines, not the product source of
  truth. Absorb reviewed changes into the canonical runtime branch rather than
  silently swapping production to an upstream checkout.

## Architecture direction

DevSpace remains the execution kernel. The surrounding platform may adopt
selected WebCodex-style mechanisms (durable Jobs, Workflow Session evidence,
managed worktree lifecycle, structured validation/finish, and a runtime
console) without copying WebCodex's centralized Server/Runner topology.
