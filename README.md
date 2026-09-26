# DevSpace-Forge

[中文说明](README.zh-CN.md)

DevSpace-Forge is the project and release line. Its DevSpace Control Platform turns a Windows or Linux machine into a persistent coding workspace that ChatGPT can use through MCP. Download one release, configure the folders you want to expose, connect one Cloudflare Tunnel, and use your own machine's files, Git repositories, terminal, build tools, and local runtime from ChatGPT.

Project data stays on your machine. The public surface is the MCP endpoint you explicitly expose through your tunnel.

**Current distribution:** [Control v0.6.8](https://github.com/PhSanqi/DevSpace-Forge/releases/tag/v0.6.8), with the same pinned [Runtime 1.1.0-beta.4.local.15](https://github.com/PhSanqi/DevSpace-Forge/releases/tag/runtime-1.1.0-beta.4.local.15) on Windows and Linux. The Control and Runtime versions are independent. Publishing a release does not upgrade an already running machine.

| Download | Format | Included |
| --- | --- | --- |
| Windows x64 | `DevSpace-Forge-v0.6.8-win-x64.zip` | `Setup.exe`, Control UI, Node.js, Runtime, cloudflared |
| Linux x64 | `DevSpace-Forge-v0.6.8-linux-x64.tar.gz` | `setup-linux.sh`, local management Console, Node.js, Runtime, cloudflared |

Download the matching `.sha256.txt` beside the archive and verify it before installation. See [versions, safe upgrades and cleanup](docs/releases-and-upgrades.md) and the [platform matrix](PLATFORMS.md).

This project is built around the DevSpace ecosystem and maintains its runtime work against both [Waishnav/devspace](https://github.com/Waishnav/devspace) and [yuezhihuafou/devspace-verge](https://github.com/yuezhihuafou/devspace-verge). See [Upstream projects](#upstream-projects) below.

## What you get

- **Full offline release packages.** Windows and Linux releases include Node.js, DevSpace Runtime, and cloudflared. End users do not need to install npm dependencies during setup.
- **One-place setup for Cloudflare.** Choose a local port, enter the public hostname and Remote Tunnel token, and the installer shows the exact local Origin and MCP URLs to use.
- **Persistent local coding access.** ChatGPT can read, search, edit, create, and inspect files inside approved roots and can run local shell commands, tests, builds, Git, package scripts, and project tools.
- **Allowed Roots.** Only directories you explicitly approve can be opened as DevSpace workspaces.
- **Project-aware Git handling.** A workspace is not automatically treated as a project. The model is instructed to find the real Git top-level directory or determine the correct project boundary before changing files.
- **Automatic Git initialization when appropriate.** If a real project has no repository, the model is instructed to initialize Git at the project root instead of an arbitrary parent folder.
- **Real Git status in the Windows UI.** See repository root, branch, HEAD, dirty/clean state, recent commits, and project ownership.
- **Independent review history and rollback.** DevSpace Review checkpoints are separate from normal Git commits and support safe rollback without forcing `git reset --hard`.
- **Long command evidence without flooding model context.** Full command output stays local while the model receives bounded previews and a stable `run_id`; stored output can be read, tailed, or searched later.
- **Runtime diagnostics and recovery.** Health checks, effective configuration, `doctor` information, service restart, and side-by-side Runtime slots help diagnose or roll back runtime problems.
- **Private management UI on Linux.** Independent loopback-only Console for services, connection/configuration history, projects and Review, Runtime versions and rollback, jobs, request diagnostics and Tunnel health. It supports Chinese/English, light/dark and responsive layouts; it is **not** the public MCP endpoint.
- **Durable work and restart protection.** Stable job identity/status/logs and reconnection. Linux local15 runs long jobs in independent user-systemd units. Runtime switches use an active-job check and shared gate; Windows native GUI and JobObject lifecycle guards have dedicated regression tests.
- **Optional multi-instance Cloudflare gateway.** Route `/server` and `/group` under one public hostname; HTTP is upgraded to HTTPS on the same host without losing the path/query, with HTTPS origin fetch and HSTS for both. The gateway Worker is deployed separately from the offline installer.
- **Optional semantic source navigation.** Serena/LSP-backed semantic navigation can be added for symbol-aware source work; it is not required for the basic Control Platform.
- **No automatic remote push.** Project Git is local unless you explicitly ask the model to push.
- **Subagents remain disabled** in the current Control Platform product scope.

## Quick start

The normal setup has four parts:

1. Download and extract the release for your OS.
2. Choose the local project root(s) and DevSpace port.
3. In Cloudflare, create one **remotely-managed Tunnel**, create a public hostname, and point it to the local Origin shown by the installer, normally `http://127.0.0.1:7677`.
4. Put the hostname and Tunnel token into DevSpace Control Platform, then connect ChatGPT or another MCP-capable client to `https://YOUR_HOSTNAME/mcp`.

The first client connection is protected by the locally generated Owner password.

You do **not** need a Cloudflare API key for an ordinary remotely-managed Tunnel install. DevSpace Control Platform does not automatically create or modify Cloudflare account resources. The optional **unified multi-instance gateway Worker** is a separate Cloudflare deployment, requiring authorized Cloudflare account access (for example Wrangler OAuth).

## Windows

Download:

```text
DevSpace-Forge-vX.Y.Z-win-x64.zip
```

Extract it and run:

```text
Setup.exe
```

The Windows ZIP is a full offline runtime bundle. `Setup.exe` expands the bundled Runtime and asks for:

- the local project root ChatGPT may access;
- the local DevSpace port, normally `7677`;
- an optional Tunnel name used only as a local label;
- the Cloudflare Tunnel origin hostname, for example `personal-origin.sanqi.org`;
- an optional unified public endpoint, for example `dev.sanqi.org/personal`. If omitted, the Tunnel origin hostname is used directly;
- the Cloudflare Remote Tunnel token.

Before saving, Setup shows the addresses you need:

```text
Cloudflare local Origin   http://127.0.0.1:7677
Local MCP                 http://127.0.0.1:7677/personal/mcp
Public MCP                https://dev.sanqi.org/personal/mcp
```

For path-routed multi-machine deployments, the Tunnel origin hostname and the unified public endpoint are intentionally different values. For example, the Cloudflare Published Application may use `personal-origin.sanqi.org -> http://127.0.0.1:7677`, while MCP clients use `https://dev.sanqi.org/personal/mcp`. Setup writes the origin hostname into DevSpace `allowedHosts` and uses the unified endpoint as the canonical public base.

After setup, `DevSpaceControlPlatform.exe` manages DevSpace and cloudflared. The Tunnel token is stored separately from ordinary settings and project Git history.

### Updating an existing Windows install

Starting with v0.6.0, a newly extracted `Setup.exe` looks for an existing Control installation in the current directory, the running Control process, and the current-user startup entry. When one is found, Setup switches to **update existing installation** mode instead of asking you to configure the machine again.

The update keeps the existing `settings.json`, Tunnel token, Owner password, state database, worktrees, and project configuration. It replaces the Control binaries, bundled Runtime, and cloudflared, then restarts Control. Legacy installs pinned to `http2` are migrated to `auto`, allowing cloudflared to choose QUIC or HTTP/2 according to the network instead of forcing TCP/7844 on every start.

Runtime-affecting GUI operations and updates use the shared active-job preflight. Do not force-close an installation during a migration; the native JobObject forced-close test is separate from acceptance on your own installed instance.

### Windows daily use

Open the Control Platform when you want to inspect or manage the service. From the UI you can:

- start, stop, or restart DevSpace and Cloudflare;
- see local and public MCP addresses;
- inspect effective configuration and runtime health;
- see the latest tool activity and command evidence;
- view project/repository ownership, branch, HEAD, dirty state, and recent commits;
- inspect DevSpace Review history and perform supported rollback operations.

## Linux

Current packaged target: **Linux x86_64**.

Download and extract:

```text
DevSpace-Forge-vX.Y.Z-linux-x64.tar.gz
```

Then run:

```bash
./setup-linux.sh
```

The Linux archive also includes Node.js, the validated DevSpace Runtime, and cloudflared. Setup does not download those runtime dependencies.

Interactive setup asks for the allowed project root, local port, Cloudflare public hostname, and Tunnel token. For unattended setup:

```bash
./setup-linux.sh \
  --allowed-root "$HOME/projects" \
  --port 7677 \
  --public-url "https://devspace.example.com" \
  --tunnel-token "YOUR_TUNNEL_TOKEN"
```

The installer prints the local Origin, local MCP URL, public MCP URL, and Owner password. It installs two user services:

```text
devspace-control.service
devspace-control-cloudflared.service
```

Useful commands:

```bash
systemctl --user status devspace-control.service
systemctl --user status devspace-control-cloudflared.service
systemctl --user restart devspace-control.service
systemctl --user restart devspace-control-cloudflared.service
```

If an existing Linux configuration is detected and no configuration-changing flags are supplied, rerunning `./setup-linux.sh` performs an in-place update: it preserves `config.jsonc`, `auth.json`, the Tunnel token, state, and worktrees while replacing the bundled Runtime, cloudflared, launch scripts, and service definitions. The regenerated Tunnel launcher uses `auto` instead of carrying forward a legacy fixed HTTP/2 launch. Use `--reconfigure` when you intentionally want to enter configuration mode again.

An existing named sidecar instance (such as `server`) uses its own services, for example `devspace-control-server.service`, `devspace-control-server-console.service` and `devspace-server-cloudflared.service`. Inspect its actual instance name and launcher before running commands. Its Console is local-only, usually the MCP port plus one; do not publish that management port through the Tunnel.

Durable jobs in Runtime local15 are supervised independently from the Linux Runtime service. A switch/restart refuses to proceed when an active job exists or when the job store cannot be safely read; this is intentional, not a reason to delete the job database.

## Cloudflare: exactly what to enter

For a remotely-managed Cloudflare Tunnel:

| Value | Where it comes from | Example |
| --- | --- | --- |
| Local Origin | DevSpace Control Platform | `http://127.0.0.1:7677` |
| Public hostname | You create it in Cloudflare | `devspace.example.com` |
| Public MCP URL | Derived automatically | `https://devspace.example.com/mcp` |
| Tunnel token | Cloudflare remotely-managed Tunnel | stored locally as a protected secret |

In Cloudflare, route the public hostname to the **local Origin**, not to `/mcp`. The MCP client uses the full public `/mcp` URL.

For a unified hostname serving several machines, deploy the separately managed `devspace-gateway` Worker and keep the hidden `server-origin` / `group-origin` Tunnel hosts distinct. Public paths such as `https://dev.sanqi.org/server/mcp` are an example of the path-routed topology. The Worker must preserve MCP/OAuth routes, upgrade HTTP to same-host HTTPS and provide HSTS; it is not part of the basic Tunnel setup.

## Using it from ChatGPT

Once the service and Tunnel are online:

1. Add the public MCP endpoint to the ChatGPT/App/connector flow you use for custom MCP servers: `https://YOUR_HOSTNAME/mcp`.
2. Complete the first connection approval with the Owner password generated during setup.
3. Ask ChatGPT to open a project located inside an Allowed Root.
4. Work normally: inspect code, edit files, run builds/tests, inspect Git, or ask for a review of the changes.

A typical request can be as simple as:

> Open `C:\Users\me\projects\my-app`, inspect the repository, fix the failing tests, run the test suite, and show me what changed.

The model receives project-boundary instructions so it can distinguish the DevSpace workspace from the actual repository/project root.

## Project and Git behavior

DevSpace Control Platform deliberately separates three concepts: the allowed root, the opened workspace, and the actual project/repository.

When work begins, the model is instructed to use an existing `git rev-parse --show-toplevel` result as the canonical Git project root. If no repository exists, it should first determine the intended project boundary and only then run `git init` there.

This avoids creating repositories in collection folders such as `projects/` or in an arbitrary nested directory. The Control UI then reports the real local Git repository and its recent commit history.

DevSpace Review history remains separate from Git. Review checkpoints exist for inspection and rollback; they are not a replacement for your normal project commits.

## Logs and long-running work

Large shell output is preserved locally instead of being injected in full into the model context. A command returns a bounded preview plus a `run_id`. Evidence can then be retrieved with:

```text
devspace-log read <runId> 1 80
devspace-log tail <runId> 80
devspace-log grep <runId> <pattern>
devspace-log meta <runId>
```

This is useful for builds, dependency installation, compilers, tests, flashing tools, and other commands where the complete output matters but should not consume the whole conversation context.

## Security notes

- Keep Allowed Roots as narrow as practical.
- Treat the public MCP URL and Owner password as access credentials to a powerful local coding tool.
- The Cloudflare Tunnel token is stored outside normal project files and settings history.
- The MCP process binds locally and is exposed through the tunnel you control.
- Review local changes before committing or pushing important repositories.

## Troubleshooting

If ChatGPT cannot connect, check these in order:

1. DevSpace is running and the local MCP URL responds.
2. cloudflared is running.
3. Cloudflare's public hostname routes to the exact local Origin shown by Control.
4. The configured public hostname matches the hostname used by the MCP client.
5. The Owner password approval has been completed.

On Linux, use the `systemctl --user status ...` commands above. On Windows, use the Control Platform status and diagnostics views.

## Build from source

For Control Platform development on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\test.ps1
powershell -ExecutionPolicy Bypass -File .\build.ps1
powershell -ExecutionPolicy Bypass -File .\build-setup.ps1
```

Release packaging is handled by `package-release.ps1`, `package-release-linux.sh`, and the GitHub Actions release workflow. Normal users should use the prebuilt release archives instead.

For the independent Runtime source/tag, artifact checks, version/installed-state distinction, and safe removal of superseded local files, use [the release and cleanup guide](docs/releases-and-upgrades.md). Official historical tags/releases are retained for traceability and rollback, even when their one-off build scripts have been removed from the current source tree.

## Upstream projects

DevSpace Control Platform exists because of the work in these upstream projects:

- **[Waishnav/devspace](https://github.com/Waishnav/devspace)** — the original MIT-licensed self-hosted MCP coding harness that exposes approved local workspaces, file operations, shell execution, Git/worktree flows, review tooling, and local-agent integration to MCP-capable hosts.
- **[yuezhihuafou/devspace-verge](https://github.com/yuezhihuafou/devspace-verge)** — an independent MIT-licensed DevSpace derivative focused on long-running agent workflows, bounded model-facing command output, durable run evidence, context quality, semantic navigation, and persistent deployment.
- **[oraios/serena](https://github.com/oraios/serena)** — optional semantic/LSP source-navigation backend used when Serena support is installed.

DevSpace Control Platform is not an official release of either DevSpace or DevSpace Verge. Its focus is packaging, installation, persistent service control, Cloudflare integration, project/Git visibility, diagnostics, recovery, and a lower-friction end-user setup around the DevSpace runtime family.

## License

MIT. See [LICENSE](LICENSE).
