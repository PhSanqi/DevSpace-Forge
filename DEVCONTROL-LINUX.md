# DevSpaceControlPlatform — Linux runtime branch

[中文说明](DEVCONTROL-LINUX.zh-CN.md)

This branch is the Linux runtime line of
[PhSanqi/DevSpaceControlPlatform](https://github.com/PhSanqi/DevSpaceControlPlatform).
It deliberately has a different source tree from the Windows `main` branch:
the Windows branch is a C# desktop control application, while this Linux branch
tracks the DevSpace runtime closely so that security and MCP changes can be
rebased from upstream with minimal drift.

## Platform split

| Platform | Branch | Current version | Role |
| --- | --- | --- | --- |
| Windows Control | `main` | `v0.3.0` | Offline `Setup.exe`, WinForms control UI, runtime supervision, Cloudflare integration, project/Git visibility, diagnostics and rollback |
| Linux runtime | `linux/context-intelligence` | `1.1.0-beta.3+local.7` | DevSpace runtime used by the Linux x86_64 offline bundle, plus the Linux context/runtime compatibility layer |
| Windows runtime | `windows/context-intelligence` | `1.1.0-beta.3+local.7.win.1` | Shared context baseline plus Windows-native artifact support |

Both lines keep the same operating principles: explicit Allowed Roots,
observable runtime state, reversible upgrades, protected tunnel credentials,
and subagents disabled in the current personal-control scope.

The cross-platform synchronization contract is documented in
[DEVCONTROL-RUNTIME-SYNC.md](DEVCONTROL-RUNTIME-SYNC.md). Shared runtime fixes
must stay aligned across Windows and Linux; OS-specific code stays on its
platform branch.

## Current Linux baseline

- Runtime version: `1.1.0-beta.3+local.7`
- Official base: `Waishnav/devspace` `v1.1.0-beta.3`
- Node: 22.x, validated with Node 22.23.2 / ABI 127
- Serena semantic backend: validated with Serena 1.7.0
- Production supervision: user systemd service via the Linux DevSpace control layer
- Public MCP pattern: Cloudflare Tunnel -> `127.0.0.1:<port>/mcp`

The Linux overlay includes:

- canonical workspace containment and upstream symlink-escape protection;
- path-scoped lazy `AGENTS.md` / `CLAUDE.md` loading;
- `context_pack` with hard context budgets;
- Serena/LSP-backed `semantic_code` symbol navigation;
- exact symbol-source slicing from semantic `body_location` data;
- bounded `read` output and symbol-first model guidance;
- compact command previews with full local `run_id` evidence storage;
- `devspace-log meta/read/tail/grep` retrieval;
- Linux PTY fallback for Node ABI 127 when upstream `node-pty` has no usable native binary;
- compatibility normalization for older ChatGPT sessions that cached camelCase MCP arguments;
- review support for Git repositories with no `HEAD` commit;
- explicit failed-process metadata in tool logs.

The full local design and upgrade invariants are documented in
[docs/context-intelligence.md](docs/context-intelligence.md).

## Upstream and attribution

This branch keeps official DevSpace as the source of truth:

- Official upstream: [Waishnav/devspace](https://github.com/Waishnav/devspace)
- Linux base tag: `v1.1.0-beta.3`

The context-management work also uses
[yuezhihuafou/devspace-verge](https://github.com/yuezhihuafou/devspace-verge)
as an important design and implementation reference, especially for two ideas:

1. compact model-visible command output while retaining full local evidence;
2. a workspace-scoped Serena semantic backend for symbol-aware queries.

The Linux branch is **not** a wholesale replacement with `devspace-verge`.
Provider orchestration, MCP lifecycle, security boundaries, workspace behavior,
and release tracking remain anchored to official DevSpace. Only the context and
semantic concepts needed by this control workflow are maintained as a small,
rebaseable overlay.

The current branch also includes these Linux-relevant fixes that landed on
official DevSpace `main` after beta3:

- `a8e5ee4` — block workspace symlink escapes;
- `2147c23` — support change reviews in repositories without `HEAD`;
- `8e4669c` — report non-zero process exits in tool logs.

Windows/macOS-only native artifact download changes are intentionally not
pulled into the Linux branch merely to match upstream commit count.

## Control Platform v0.3.0 integration

The Linux runtime is packaged by DevSpaceControlPlatform as
`DevSpaceControlPlatform-vX.Y.Z-linux-x64.tar.gz`. The archive contains Node.js,
the validated DevSpace runtime, cloudflared, and `setup-linux.sh`; end users do
not need to install npm dependencies during setup.

The Linux installer uses the same user-facing contract as Windows: Allowed
Root, local DevSpace port, Cloudflare public hostname, Remote Tunnel token,
local Origin, local MCP URL, public MCP URL, and Owner password/approval.

The Control Platform README is the user-facing installation and daily-use
documentation. This branch document remains focused on runtime maintenance and
platform-specific behavior.

## Validation state

The `local.7` baseline was validated with:

- TypeScript typecheck;
- the complete source test suite: `157 passed`, `0 failed`, `1 skipped`;
- real Serena symbol/context queries;
- bounded context and compact-log retrieval;
- local and public MCP authentication probes;
- real PTY spawn, input, resize, and exit behavior;
- cached camelCase MCP-client compatibility;
- unborn-Git-repository `show_changes` behavior;
- non-zero process exit logging.

## Maintenance rule

Do not treat this branch as an independent DevSpace product fork. For a new
official DevSpace release:

1. rebase security, workspace, MCP, and review changes first;
2. keep upstream behavior when there is a conflict;
3. reapply only the smallest context/semantic/runtime compatibility overlay;
4. run the full tests and real runtime smoke checks;
5. deploy through a parallel runtime and retain the previous runtime as an
   immediate rollback point.

The purpose of this branch is to make the Linux control environment efficient
for long-running AI coding sessions without losing the ability to follow
official DevSpace releases.
