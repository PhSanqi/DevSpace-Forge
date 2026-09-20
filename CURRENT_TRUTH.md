# Current Truth

Date: 2026-09-20

## Product boundary

This repository is no longer only a Windows DevSpace control application. It is
the cross-platform platform around DevSpace: runtime packaging, secure remote
MCP exposure, lifecycle supervision, diagnostics, review/evidence and future
durable workflow features.

DevSpace remains the execution kernel. The platform may absorb selected ideas
from DevSpace Verge and WebCodex, but upstream projects are references rather
than replacement runtime sources.

Subagents remain disabled unless the product scope is explicitly changed.

## Production topology

Canonical public MCP endpoints:

- Group: https://dev.sanqi.org/group/mcp
- Server: https://dev.sanqi.org/server/mcp

Cloudflare Worker devspace-gateway routes path families to hidden per-machine
Tunnel origins:

- group-origin.sanqi.org
- server-origin.sanqi.org

DevSpace owns OAuth. Cloudflare Access OAuth is not stacked in front of it.

### Group / Windows

- DevSpace local port: 17677
- Public base URL: https://dev.sanqi.org/group
- ControlPlatform owns the local Windows lifecycle.
- Legacy 7677/4060 runtime is retired.
- Current deployed cloudflared is older than the canonical package target and
  must be upgraded to 2026.9.1 during the next deployment convergence.

### Server / Linux

- DevSpace local port: 17677
- Public base URL: https://dev.sanqi.org/server
- devspace-control-server.service owns DevSpace.
- devspace-server-cloudflared.service owns the Tunnel connector.
- Legacy Python Control, port 7676, and management page 8787 are retired.

## Runtime baseline

The next canonical runtime line is 1.1.0-beta.4+local.9.

It is based on the beta4 image/context runtime and includes:

- upstream workspace containment and native artifact fixes;
- compact bounded command evidence and durable run IDs;
- path-scoped context intelligence and Serena/LSP semantic navigation;
- image-aware context runtime;
- path-based MCP/OAuth public bases such as /group and /server;
- the upstream Codex empty-turn fallback fix from 2026-09-18;
- Serena stderr handling that avoids an unread-pipe deadlock.

Windows and Linux should consume builds from the same canonical runtime source.
Platform-specific packaging differences are expected; divergent source behavior
under the same package version is not.

## Source convergence

Historical development diverged between the old Windows master line and the
main/release line. The canonical history is now based on a905354 and absorbs
the verified Windows and Linux changes into one source line.

Platform-specific files may differ, but shared source, runtime version,
Cloudflare gateway logic and release metadata must have one canonical owner.

## External projects

### Official DevSpace

Official DevSpace remains the upstream baseline. New upstream commits are
reviewed and selectively rebased/cherry-picked rather than replacing the local
runtime blindly.

### DevSpace Verge

Verge is an attributed reference for compact model-facing output, stable run
evidence, durable process handling, semantic navigation and retention. Those
ideas are already substantially present in the local runtime. Do not install
Verge wholesale over production.

### WebCodex

High-value mechanisms to absorb:

1. durable Job identity/observation/cancellation;
2. bounded Workflow Session evidence and handoff;
3. managed worktree lifecycle and hygiene checks;
4. structured validation plus an explicit finish contract;
5. Runtime Console views for jobs, sessions and recent activity.

Do not adopt WebCodex's centralized Server/Runner topology by default. The
current per-machine DevSpace model remains simpler and fits the deployment.

## Security invariants

- Keep allowed roots narrow and validated.
- Keep trustProxy=false for the loopback cloudflared origin path.
- Keep owner passwords and Tunnel tokens out of settings history, logs and Git.
- Prefer protected token-file credentials over plaintext command arguments.
- show_changes/Git evidence is review evidence, not permission by itself.
- Destructive cleanup and external publication remain explicit operations.
