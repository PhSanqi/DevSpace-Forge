# DevSpace-Forge v0.6.12

v0.6.12 is a Windows control-plane and release-reliability update. It also tightens the public-repository privacy boundary. The embedded Runtime remains on the pinned `1.1.0-beta.4.local.15` compatibility line and ships inside the same product package.

## Highlights

### Modern Windows ownership

Windows installations now use a single modern Desktop launcher to coordinate the loopback Control console and managed Runtime/Tunnel services. The launcher guards against a same-root legacy manager, verifies that the Control port belongs to the current installation root, and keeps the managed Control service independent from the lifetime of the Desktop window.

Existing installations should upgrade through `Setup.exe`. The update path replaces legacy autostart ownership with the modern launcher instead of leaving two startup entries active.

### Deployment-neutral instance identity

The Windows launcher no longer assumes one fixed instance name. It resolves the instance from the configured public route, so installations can use deployment-specific paths such as `/team-a` or `/team-b` without publishing those names in source code.

### More robust Windows offline packages

The Windows release flow now stages Runtime and native video dependencies through bounded short paths before packaging and smoke tests. This reduces failures caused by long Windows paths and native dependency extraction while keeping the shipped Runtime payload pinned and checksummed.

### Media delivery is part of success

Image-generation workflows now require the generated media to be delivered through the supported media path. A generation call that produces an asset but fails to deliver it is no longer treated as a complete success.

### Public repository privacy

The public tree is guarded against deployment-specific hostnames, local developer paths, credential formats and personal Git email addresses. Documentation uses generic examples such as `workspace.example.com`; actual domains, credentials, local paths and instance state stay outside the repository.

## Upgrade checklist

1. Back up the current installation and confirm no durable task is actively using the Runtime.
2. Download the v0.6.12 package for the target platform and verify its SHA-256 sidecar.
3. On Windows, extract the archive and run `Setup.exe`; use the detected existing-installation update path.
4. Confirm the configured Allowed Roots and public MCP route still match the intended installation.
5. Verify the local Runtime and loopback Control are healthy, then verify the public MCP endpoint from the client.
6. Keep the previous working backup until the new installation has passed normal project access, MCP, media and restart checks.

Do not copy real Tunnel credentials, Owner secrets, local state databases or deployment hostnames into issues, screenshots or repository files.

---

## 中文说明

v0.6.12 主要更新 Windows 控制面与发行可靠性，并进一步收紧公开仓库的隐私边界。内嵌 Runtime 仍保持在固定的 `1.1.0-beta.4.local.15` 兼容线，并继续与产品包一起发布。

### Windows Modern Desktop ownership

Windows 安装现在由单一 Modern Desktop launcher 协调 loopback Control、Runtime 与 Tunnel。launcher 会检查同安装根目录下的 legacy manager 冲突，确认 Control 端口确实属于当前安装根，并让 Control 服务生命周期独立于 Desktop 窗口本身。

已有安装直接通过 `Setup.exe` 的更新流程升级。更新会把旧自启动 ownership 收敛到 modern launcher，不保留两套启动项并行运行。

### Instance identity 不再绑定固定部署名称

Windows launcher 会根据已配置的公网 route 解析 instance，不再在源码里假定某个固定名称。因此 `/team-a`、`/team-b` 这类不同部署可以保持各自 identity，同时公开源码仍保持通用。

### Windows 离线包更稳定

Windows Release 在打包和 smoke test 前会把 Runtime 与视频原生依赖放到有界短路径中 staging，减少长路径与原生依赖解包造成的失败，同时继续对内嵌 Runtime payload 固定版本并做校验。

### 媒体真正交付才算成功

图片生成流程现在要求生成结果通过支持的媒体路径真正交付。只生成文件但没有成功交付，不再被视为完整成功。

### 公开仓库隐私边界

公开仓库会检查部署专用 hostname、本机开发路径、常见凭据格式和个人 Git 邮箱。文档只使用 `workspace.example.com` 等通用示例；真实域名、凭据、本机路径和实例状态都应留在仓库之外。

### 升级检查

1. 备份当前安装，并确认没有持久任务正在占用 Runtime。
2. 下载对应平台的 v0.6.12 安装包并核对 SHA-256。
3. Windows 解压后运行 `Setup.exe`，使用检测到的已有安装更新流程。
4. 检查 Allowed Roots 与公网 MCP route 是否仍指向预期配置。
5. 验证本地 Runtime、loopback Control 与公网 MCP 连接。
6. 在项目访问、MCP、媒体和重启检查都通过前，保留上一版可工作的 rollback 备份。

不要把真实 Tunnel credential、Owner secret、本地状态数据库或部署 hostname 放进 Issue、截图或仓库文件。
