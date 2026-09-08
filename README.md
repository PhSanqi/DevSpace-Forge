# DevSpace Control Platform

[中文](README.zh-CN.md)

DevSpace Control Platform is a Windows desktop control plane for running and supervising a local [DevSpace](https://github.com/Waishnav/devspace) instance behind Cloudflare Tunnel.

It is designed for people who want DevSpace to behave like a normal background application instead of a collection of command-line setup steps.

## What it provides

- Start / stop / restart DevSpace and Cloudflare independently.
- Tray application with persistent background service supervision.
- Version-aware DevSpace configuration for the validated 1.0.x and 1.1.x configuration families.
- Managed Allowed Roots, tool mode, skills, logging, and effective-config diagnostics.
- Protected Cloudflare Remote Tunnel token storage outside normal settings/history.
- `doctor` and effective configuration inspection from the UI.
- Per-GPT-workspace tool-call logs, separated from infrastructure/service logs.
- Per-Git-project review history generated from DevSpace `show_changes`.
- Multi-version rollback with safety checks instead of `git reset --hard`.
- Independent platform-settings history.

Subagents are intentionally disabled in the current product scope.

## Code version history

Each Git project gets its own review timeline:

```text
Project A: V0 -> V1 -> V2 -> V3
Project B: V0 -> V1
```

Every observed `show_changes` creates a hidden Git snapshot and a concise review description. Earlier active versions can be selected and rolled back in one operation. Rollback first checks that the reverse patch can still be applied safely; later conflicting edits are not overwritten automatically.

GPT conversations are tracked separately by DevSpace `workspaceId`, so logs from parallel conversations do not get mixed together even when they touch the same project.

## Cloudflare model

The recommended setup is a remotely-managed Cloudflare Tunnel:

```text
ChatGPT / MCP client
        |
        v
Cloudflare hostname
        |
        v
cloudflared
        |
        v
127.0.0.1:<DevSpace port>/mcp
```

The Tunnel token is stored in a protected local secret file and is excluded from normal settings, configuration history, and Git.

## Build

The desktop application is currently built with the Windows .NET Framework C# compiler available on the target machine:

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

Output:

```text
bin\DevSpaceControlPlatform.exe
```

The repository intentionally does **not** commit managed runtime/state directories such as `runtime/`, `state/`, `logs/`, or `bin/`.

## Install a release

1. Download and extract `DevSpaceControlPlatform-vX.Y.Z-win-x64.zip` from GitHub Releases.
2. In the extracted directory, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-runtime.ps1
```

3. Start `DevSpaceControlPlatform.exe`.
4. Add the project roots DevSpace may access, choose a local port, and configure a Cloudflare Remote Tunnel hostname.
5. Paste the Tunnel token once into the protected Token field and save it.

The lightweight release does not include Node.js, DevSpace, cloudflared, machine settings, logs, OAuth state, or Tunnel secrets. `setup-runtime.ps1` downloads and verifies the pinned runtime components locally.

## Upstream DevSpace

This project is built **around** DevSpace, but it is not a source fork of DevSpace itself.

- Upstream project: [Waishnav/devspace](https://github.com/Waishnav/devspace)
- DevSpace owns the MCP server, workspace lifecycle, tools, review checkpoints, skills, and runtime behavior.
- DevSpace Control Platform owns the Windows control UI, process supervision, tunnel integration, configuration adaptation, diagnostics, and local review/rollback presentation.

The local `upstream/devspace` checkout used during development is reference-only and is excluded from this repository.

## Current scope

This project currently targets Windows and a personal/local DevSpace workflow. It is not intended to replace DevSpace internals or become another agent harness.

The main design rule is to expose DevSpace capabilities while keeping the control layer small, inspectable, and reversible.

