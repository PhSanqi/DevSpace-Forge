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

The Windows `main` branch of DevSpaceControlPlatform should consume a packaged
artifact built from this runtime branch rather than reimplementing the shared
runtime changes as an ever-growing text patch against npm `1.1.0-beta.3`.

That keeps Windows and Linux context behavior aligned while allowing each
platform to carry only the OS-specific runtime changes it actually needs.
