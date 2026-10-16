# DevSpace-Forge v0.6.14

v0.6.14 is a focused Windows Tunnel stability and observability release. It does not change the embedded Runtime version and does not force a new global Tunnel protocol default.

## Highlights

- **Modern Controller honors the persisted Tunnel protocol:** `CloudflaredProtocol` is read from `settings.json`, with the legacy `CloudflareProtocol` alias retained for compatibility. Valid values are `auto`, `quic`, and `http2`; invalid persisted values fail closed instead of being silently ignored.
- **Explicit protocol choices survive upgrades:** Windows Setup no longer resets an existing explicit Tunnel protocol to `auto` during update or remote reconfiguration. Fresh installations still default to `auto`.
- **Windows Console diagnostics use real evidence:** request and Tunnel diagnostics can consume controller-owned logs on Windows, parse the pretty runtime log format, discover the local Cloudflared metrics endpoint, and report HA connections from metrics.
- **Unknown stays unknown:** when neither logs nor metrics provide connection evidence, the Console reports an unknown connection count instead of a synthetic zero.

## Why this matters

On networks where QUIC is intermittently unhealthy but TCP/HTTP/2 remains stable, administrators can now select `http2` for that instance and rely on Modern Control and Setup to keep the choice. Other installations are not forced away from `auto`.

## Validation

- Linux Node regression: 65 tests, 63 passed, 2 skipped, 0 failed.
- Windows full-candidate Node regression: 65 tests, 64 passed, 1 skipped, 0 failed.
- Windows targeted Setup update regression passed for preserving an existing explicit protocol.
- A production-style Group A/B test observed stable public health and real MCP execution during the explicit HTTP/2 window; the same host's restored `auto` path continued retrying unstable QUIC links. This evidence supports an instance-specific HTTP/2 setting, not a global default change.

## Upgrade notes

1. Download the v0.6.14 package for the target platform and its SHA-256 sidecar from GitHub Releases.
2. Verify the archive checksum before extraction.
3. On Windows, use the normal `Setup.exe` update flow for an existing installation.
4. Existing explicit `http2` or `quic` settings are preserved. Existing `auto` installations remain `auto` unless an administrator intentionally changes the instance setting.
5. After upgrade, verify local Control, Runtime, MCP, public Tunnel health, and Tunnel HA metrics before removing rollback material.

The embedded Runtime remains `1.1.0-beta.4.local.15`.

---

# DevSpace-Forge v0.6.14 中文说明

v0.6.14 是一次聚焦 Windows Tunnel 稳定性与可观测性的修复版本。它不修改内嵌 Runtime 版本，也不会强制改变所有安装实例的 Tunnel 默认协议。

## 主要变化

- **Modern Controller 正式执行持久化 Tunnel 协议：** 从 `settings.json` 读取 `CloudflaredProtocol`，并兼容旧字段 `CloudflareProtocol`。有效值为 `auto`、`quic`、`http2`；无效值会 fail-closed，不再静默忽略。
- **显式协议在升级后继续保留：** Windows Setup 更新与远程重新配置不再把已有显式协议重置为 `auto`；全新安装仍默认 `auto`。
- **Windows Console 使用真实诊断证据：** MCP/Tunnel 诊断可以读取 Controller 自有日志、解析 Runtime pretty log、自动发现本地 Cloudflared metrics，并从 metrics 报告真实 HA 连接数。
- **没有证据就保持 Unknown：** 日志和 metrics 都无法提供连接证据时，不再用伪造的 0 掩盖诊断盲区。

## 升级后检查

Windows 使用正常 `Setup.exe` 更新流程。已有 `http2` / `quic` 显式选择会被保留；原本为 `auto` 的实例不会自动切换。升级后应依次确认本地 Control、Runtime、MCP、公网 Tunnel health 与 HA metrics 正常，再清理回滚材料。

内嵌 Runtime 继续固定为 `1.1.0-beta.4.local.15`。
