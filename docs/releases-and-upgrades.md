# Releases, upgrades and cleanup / 发布、升级与清理

This guide describes the v0.6.8 Control release line and the independently tagged Runtime `1.1.0-beta.4.local.15`. A GitHub Release is a distributable artifact, not proof of an installation's current state.

## Download and verify

| Machine | Release asset | Install entry |
| --- | --- | --- |
| Windows x64 | `DevSpace-Forge-v0.6.8-win-x64.zip` | Extract and run `Setup.exe` |
| Linux x64 | `DevSpace-Forge-v0.6.8-linux-x64.tar.gz` | Extract and run `./setup-linux.sh` |

Each archive has a matching `.sha256.txt` file. Verify the SHA-256 before extracting or running. Both bundles contain pinned Node.js, the same independently tagged Runtime and cloudflared, and a `control-provenance.json` describing the frozen source commit and shipped console asset hashes. Runtime has its own `runtime-provenance.json`. Do not package a dirty checkout or claim a build by simply changing a version string.

The Runtime source tag and its source/portable package release are distinct from the two OS-specific Control bundles. Keep the tag as a reproducible upstream build reference; a portable Runtime package alone is not an offline Windows/Linux installation.

## Safe update

1. Confirm the current actual process, configured Runtime, local/public MCP and Console health, Tunnel PID, active durable-job count, current launcher and backups.
2. Keep state, auth, Tunnel token and the currently working Runtime untouched during preparation. On Windows, use the official newer `Setup.exe` update-existing flow; on Linux, rerun the official `setup-linux.sh` or the installed instance's documented sidecar update procedure.
3. Runtime-affecting actions acquire the shared switch gate and fail closed if jobs are active or the SQLite state cannot be checked. A Control-only update must not restart DevSpace/Tunnel merely to update static console assets.
4. Verify installed `control-provenance.json` against the shipped files, actual/configured Runtime identity, CLI and Console launchers, HTTP health, MCP/OAuth and Tunnel PID. An upload/CI success is not a deployed-state test.
5. Restore the saved launcher/installation if the new version fails the acceptance gate; preserve evidence and explain whether an automatic recovery succeeded.

The Linux sidecar instance used for `/server` has distinct services `devspace-control-server.service`, `devspace-control-server-console.service` and `devspace-server-cloudflared.service`; generic installs use names such as `devspace-control.service`. Never substitute a generic service name into a named-instance command.

## Gateway is a separate deployment

The single-host multi-instance gateway is `ops/cloudflare-gateway-worker.mjs`, deployed as Cloudflare Worker `devspace-gateway`. It preserves `dev.sanqi.org`, path and query on HTTP→HTTPS (308), fetches from the hidden server/group origins over HTTPS, and adds HSTS to ordinary proxied responses. MCP/OAuth routes remain instance-specific; this Worker is **not** the privileged loopback Console.

For a Worker change, record the deployed version ID, upload a new version without changing routes or deleting existing vars, stage/test it, deploy the exact ID, and verify server/group health, anonymous MCP 401, OAuth discovery, HSTS and Tunnel continuity. The previously deployed Worker version is the rollback anchor. A new Control release does not automatically deploy a Worker.

## What can be cleaned

Before removing anything, check active PIDs, launchers, `runtime-package` references, Runtime rollback inventory, saved backups, outstanding jobs, and Git worktrees.

- **Keep:** immutable published Git tags/releases, SHA sidecars, production Control/Runtime, the most recent verified rollback path, credentials/state and explicit recovery backups. Historical release downloads remain available for audit and recovery.
- **Remove after checking references:** superseded version-specific setup scripts no longer referenced by current workflows; orphan, clean, unreferenced build outputs; stale temporary test downloads. Use `git worktree prune -n -v` to preview stale metadata before pruning.
- **Do not delete by age alone:** `runtime-local12/13/14/15`, historical candidate slots, `backups/`, `staging/`, user workspaces, uncommitted branches or a directory merely called “old”. A rollback or previous installation may still point to them.

The obsolete v0.3.0 one-off package/switch/rollback source scripts were removed from the current source tree in v0.6.8. Their historical Git commit and release assets remain recoverable. No past public releases were rewritten or deleted.

Cleanup audit (2026-09-26): the old `DevSpace-Forge-control-v062fix` checkout still contains uncommitted edits, so it was **not** removed. The live Linux launcher references `runtime-local15`. Earlier Runtime directories and installer recovery backups were deliberately retained rather than treated as unreferenced by their names alone. No production state database, user workspace or published Release was deleted.

## Release acceptance

The annotated Control tag `v0.6.8` should trigger the GitHub Actions Linux, Windows and release jobs. Require all three success statuses, each complete archive and SHA sidecar, a clean provenance manifest, a verified Runtime tag, and the correct package version in the extracted artifacts. Only then call the Release published. Record a production deployment separately.

中文摘要：Windows ZIP 与 Linux tar.gz 是两个独立验收的离线发行包；Runtime local15 有单独标签。旧正式 Release 保留，优先清理没有引用的临时构建文件，不删除生产、备份和回滚目录。更新必须先核对活动任务，再检查安装后的真实进程、MCP/OAuth 与 Tunnel。
