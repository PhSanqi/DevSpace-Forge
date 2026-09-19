# DevSpaceControlPlatform — Windows runtime branch

This branch is the Windows DevSpace runtime line used by
[PhSanqi/DevSpaceControlPlatform](https://github.com/PhSanqi/DevSpaceControlPlatform).

## Baseline

- Runtime version: `1.1.0-beta.3+local.7.win.1`
- Shared context-intelligence baseline: Linux `local.7`
- Official DevSpace base: `Waishnav/devspace` `v1.1.0-beta.3`
- Windows-specific upstream sync: `eaf8f3e` native artifact downloads on Windows

The shared `local.7` layer provides the same context behavior used by the Linux
runtime: path-scoped lazy instructions, `context_pack`, Serena semantic queries,
bounded reads, compact command evidence with `run_id`, cached camelCase client
compatibility, symlink containment, unborn-repository reviews, and explicit
non-zero process logging.

## Windows-specific behavior

Windows keeps the upstream Windows process/PTY behavior rather than importing
the Linux PTY fallback. The additional platform-specific code on this branch is
the upstream native artifact-download implementation for Windows.

The context and semantic direction continues to reference
[yuezhihuafou/devspace-verge](https://github.com/yuezhihuafou/devspace-verge)
for compact model-visible output and workspace-scoped Serena integration, while
official DevSpace remains the source of truth for security, MCP, workspace, and
release contracts.

## Control Platform integration

DevSpaceControlPlatform `v0.3.0` packages the Windows runtime into a complete
offline ZIP with `Setup.exe`, Node.js, cloudflared, and the validated DevSpace
runtime. Setup collects Allowed Root, local port, Cloudflare public hostname,
Remote Tunnel token, and shows the resulting local/public MCP addresses.

Shared runtime changes must remain aligned with `linux/context-intelligence`.
Windows-only native artifact code remains on this branch. The synchronization
contract is documented in [DEVCONTROL-RUNTIME-SYNC.md](DEVCONTROL-RUNTIME-SYNC.md).
