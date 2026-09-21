# Current Truth

Date: 2026-09-21

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
- Active runtime slot: `windows-beta4-local12`.
- Deployed DevSpace version: `1.1.0-beta.4.local.12`.
- Deployed cloudflared version: `2026.9.1`.
- The production Control Platform is the validated P0/P2 build with SHA256
  `A52E13DF7678D636B8AE57DAAF8E99E3225124C8DCAD12E613AED594798C65D4`.
- Group local health and `https://dev.sanqi.org/group/healthz` are verified
  HTTP 200 after the local.12 cutover, and Group MCP reconnect is verified.
- cloudflared runs with `--protocol http2` and token-file credentials.
- The earlier HTTP 530 incident was not a Cloudflare path-routing failure.
  cloudflared remained connected but logged repeated
  `127.0.0.1:17677` connection-refused / forcibly-closed origin errors while
  the managed DevSpace process was down. The failed in-band runtime/control
  upgrade tied its recovery command to the DevSpace process tree it was
  stopping.
- Runtime cutover and Control Platform replacement were subsequently completed
  through WMI-created out-of-band processes. The runtime switch produced only a
  brief public 502 before returning to HTTP 200, and the Control Platform
  updater completed with `update-ok` after local health recovery.
- Future Control Platform replacement must use
  `update-control-platform-out-of-band.ps1` rather than an in-band managed
  DevSpace command.
- The pre-convergence local8 slot and cloudflared 2026.8.2 binary are retained
  only as rollback material.

### Server / Linux

- DevSpace local port: 17677
- Public base URL: https://dev.sanqi.org/server
- devspace-control-server.service owns DevSpace.
- devspace-server-cloudflared.service owns the Tunnel connector.
- Deployed DevSpace version: `1.1.0-beta.4.local.12`.
- The live runtime is `runtime-local12`; its deployed `dist/server.js`
  SHA256 is
  `c1ac694e6067ea54d9a7035382e7ef0ef62976ca80a6bc53a2d99fe8ae75351b`.
- `devspace-server-cloudflared-watchdog.timer` is enabled and active.
- Runtime Console is installed and resolves the live runtime from the systemd
  main process rather than assuming a fixed package directory.
- Legacy devspace-control.service, port 7676, management page 8787 and its
  legacy Tunnel connector are stopped and disabled. Their runtime/state are
  retained only for rollback; `/server` and `/group` no longer depend on them.

## Runtime baseline

The canonical runtime line is `1.1.0-beta.4.local.12` from
`runtime/beta4-unified`.

It is based on the beta4 image/context runtime and includes:

- upstream workspace containment and native artifact fixes;
- compact bounded command evidence and durable run IDs;
- path-scoped context intelligence and Serena/LSP semantic navigation;
- image-aware context runtime;
- path-based MCP/OAuth public bases such as /group and /server;
- the upstream Codex empty-turn fallback fix from 2026-09-18;
- Serena stderr handling that avoids an unread-pipe deadlock;
- bounded Serena warm/fallback behavior for first-call latency;
- first-class durable Jobs with persisted status/logs/cancellation;
- recoverable mutation receipts via `operation_id`;
- reconnect-safe Job discovery by canonical workspace root;
- request lifecycle/first-byte diagnostics.

Windows and Linux should consume builds from the same canonical runtime source.
Platform-specific packaging differences are expected; divergent source behavior
under the same package version is not.

Linux Server and Windows Group are both deployed and serving local.12. Their
runtime source and release asset are canonical, and dual-platform production
serving convergence is verified.

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

The local platform already has several foundations that overlap the useful
WebCodex mechanisms: bounded durable `run_id` evidence, managed worktrees and
pruning, review evidence, and readiness/session-oriented management surfaces.
Those foundations do not mean the WebCodex absorption roadmap is complete.

Still-open mechanisms to absorb:

1. bounded Workflow Session evidence and handoff;
2. a fully explicit managed worktree finish/hygiene lifecycle;
3. structured validation plus an explicit finish contract.

Durable Job identity/observation/cancellation is implemented in local.12.
Runtime Console now exposes runtime/Tunnel state, Jobs, workspaces and recent
request diagnostics; first-class Workflow Session rows depend on the remaining
Workflow Session work.

Do not adopt WebCodex's centralized Server/Runner topology by default. The
current per-machine DevSpace model remains simpler and fits the deployment.

## Security invariants

- Keep allowed roots narrow and validated.
- Keep trustProxy=false for the loopback cloudflared origin path.
- Keep owner passwords and Tunnel tokens out of settings history, logs and Git.
- Prefer protected token-file credentials over plaintext command arguments.
- show_changes/Git evidence is review evidence, not permission by itself.
- Destructive cleanup and external publication remain explicit operations.
