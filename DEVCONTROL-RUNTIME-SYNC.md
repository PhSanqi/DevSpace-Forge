# DevSpaceControlPlatform runtime synchronization

This branch is one of the DevSpace runtime lines consumed by
[PhSanqi/DevSpaceControlPlatform](https://github.com/PhSanqi/DevSpaceControlPlatform).
The Control Platform `v0.3.0` release line packages complete Windows and Linux
runtime bundles so end users do not have to install Node.js, DevSpace, or
cloudflared separately.

## Shared runtime contract

Windows and Linux must keep the same behavior for changes that are not
OS-specific. The current shared baseline includes:

- path-scoped lazy `AGENTS.md` / `CLAUDE.md` instructions;
- bounded `read` and `context_pack`;
- Serena/LSP-backed `semantic_code` when Serena is available;
- compact command previews with complete local evidence addressed by `run_id`;
- `devspace-log meta/read/tail/grep`;
- compatibility normalization for cached camelCase MCP arguments;
- canonical workspace containment and symlink-escape protection;
- change review support for Git repositories without `HEAD`;
- explicit non-zero process exit metadata;
- the same workspace/project/repository semantics expected by the Control
  Platform.

Shared fixes should be applied to both runtime branches before a Control
Platform release is considered synchronized.

## Platform-specific code

Platform-specific fixes are intentionally not mirrored when they do not apply:

- Windows keeps the native artifact-download implementation and Windows process
  behavior.
- Linux keeps the Linux PTY fallback and Linux service/runtime integration.

This is feature parity, not byte-for-byte branch equality.

## Control Platform release contract

The Control Platform packages these runtimes as complete end-user artifacts:

- Windows: `DevSpaceControlPlatform-vX.Y.Z-win-x64.zip` with `Setup.exe`.
- Linux: `DevSpaceControlPlatform-vX.Y.Z-linux-x64.tar.gz` with
  `setup-linux.sh`.

Both installers expose the same user-facing configuration model: Allowed Root,
local DevSpace port, Cloudflare public hostname, Remote Tunnel token, local
Origin, local MCP URL, public MCP URL, and Owner password/approval.

The Control Platform keeps Subagents disabled in its current product scope.

## Upstream

- Official source of truth:
  [Waishnav/devspace](https://github.com/Waishnav/devspace)
- Context/runtime reference:
  [yuezhihuafou/devspace-verge](https://github.com/yuezhihuafou/devspace-verge)

DevSpace Verge is an independent derivative, not the official upstream. Its
long-session, bounded-output, durable-evidence, and semantic-navigation work is
used as a reference where it fits the Control Platform workflow.
