# Platforms and release channels / 平台与版本

Updated: 2026-09-26. The canonical release line is **DevSpace-Forge Control v0.6.8**, bundling **DevSpace Runtime 1.1.0-beta.4.local.15**. Control and Runtime have independent versions and Git tags; do not infer a deployed version from a checkout or a filename.

| Deliverable | Git tag / source | Distribution |
| --- | --- | --- |
| Windows x64 Control + Runtime | `v0.6.8` / Control `main` | `DevSpace-Forge-v0.6.8-win-x64.zip` with `Setup.exe` |
| Linux x64 Control + Runtime | `v0.6.8` / Control `main` | `DevSpace-Forge-v0.6.8-linux-x64.tar.gz` with `setup-linux.sh` |
| Shared Runtime source | `runtime-1.1.0-beta.4.local.15` / `runtime/beta4-unified` | Canonical Runtime archive; bundled into both OS packages |
| Cloudflare path gateway | Control `ops/cloudflare-gateway-worker.mjs` | Independently deployed Worker, not installed by Setup |

The Windows and Linux offline packages contain Node.js, the pinned Runtime and cloudflared. They are separate build artifacts from the same Control tag and Runtime tag, with independent SHA-256 sidecars and provenance. The Runtime is not assumed to match a Control version number.

**Deployment is a separate fact.** The Linux Server instance has been verified running Control 0.6.7 and Runtime local15 before this v0.6.8 release; a new GitHub Release does not itself update a deployed machine. The Group Windows machine must be checked separately before claiming its installed version. Maintain the prior verified runtime and backup until an explicit local upgrade/rollback is accepted.

The server's independent loopback-only management UI is not a public Cloudflare endpoint. Path-routed public MCP/OAuth use `https://dev.sanqi.org/server` and `https://dev.sanqi.org/group`. The gateway Worker handles HTTP→same-host HTTPS and HSTS; Tunnel origin hostnames are distinct.

For version selection, installation, preservation rules and release checks see [Release and upgrade guide](docs/releases-and-upgrades.md). Historical tags/releases are immutable recovery and audit evidence, not alternate current binaries.

中文：Windows、Linux 是同一产品的两个离线成品包；Control 与 Runtime 各自维护版本和标签。发布新 Release 不代表已经切换生产。不要删除运行中、启动器引用、备份引用或尚待验证的 Runtime。
