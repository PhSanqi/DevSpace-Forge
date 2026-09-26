# Current Truth / 当前事实

Verified on 2026-09-26. Distinguish **source**, **official release**, **installed Control**, **configured Runtime**, **actually running Runtime**, and **Cloudflare edge**. They are not interchangeable.

## Product and source

- Control source: `main`, with the v0.6.8 release line based on the verified v0.6.7 build and the canonical gateway HSTS change. Runtime source: `runtime/beta4-unified`, tagged `runtime-1.1.0-beta.4.local.15`.
- Linux/Windows product packages embed the same tagged Runtime but have separately verified offline OS dependencies and manifests.
- DevSpace is the execution kernel; this Control Platform is an independent, unofficial distribution built with upstream attribution.
- No centralized Server/Runner or Control subagents are enabled in the current product.

## Public routing and security

- Canonical paths: `https://dev.sanqi.org/server/mcp` and `https://dev.sanqi.org/group/mcp`; hidden origins are `server-origin.sanqi.org` and `group-origin.sanqi.org`.
- `devspace-gateway` production Worker version `b4a0d81c-af99-45dd-aeaf-39ea51dcb64e`, deployment `fef9635e-1ef0-4a6a-802d-9dd4e36ffde7`, at 100% at acceptance. Canonical HTTP redirects (308) retain host, path and query; HTTPS origins are used for fetch. Both server and group HTTPS health (200), unauthenticated MCP (401), OAuth protected-resource metadata (200) and HSTS `max-age=3600` were verified.
- The previous Worker versions `5e20a115-c763-4c07-b8e6-4dbf3bda991a` and `7e774dce-8d85-4d89-bdf1-b756a72b83e6` remain rollback anchors. Gateway deployment is independent of bundled Control installers.
- The loopback-only Management Console is **not** exposed through the public MCP Tunnel; Owner password and Tunnel credentials are not included in normal status/log output.

## Linux Server installed-state snapshot

At the gateway cutover, the installed Control was official **0.6.7** at commit `c14a6f3b19d544c1df8f317475cfaef9966011bb`, `source_dirty=false`; Runtime launcher selected **local15**. The DevSpace, Console and Tunnel services remained active. Public MCP health and local Console status returned HTTP 200. Publishing v0.6.8 does **not** assert that it is deployed here.

The Linux Server has separate DevSpace, loopback Console and Tunnel user services. Existing prior runtime directories/launcher backups are retained for rollback until verified safe to prune; never infer they are disposable simply because a newer tag exists.

## Windows Group

Control/Runtime are independently installed and must be observed on the Windows host. Cross-platform source parity, Windows native GUI tests and official Windows archive CI do not by themselves prove the Group installation has been updated. Windows lifecycle guards and JobObject forced-close survival have isolated tests.

## Runtime behavior

The canonical local15 runtime includes durable jobs and Linux process/cgroup isolation. Long tasks must survive the normal Linux Runtime service lifecycle independently, while Runtime-affecting actions check active jobs and fail closed. Preserve stable IDs, logs, cancellation and reconnect semantics. Do not claim all historical local12/local13 processes had this isolation.

## Cleanup policy

Preserve published tags/releases, provenance, recovery backups, active launchers, state databases and any referenced Runtime. Delete only verified orphan build/staging copies, legacy version-specific helpers no longer referenced by current setup, or safe Git-ignored outputs. See [release/cleanup procedure](docs/releases-and-upgrades.md); track the actual cleanup separately from this historical snapshot.
