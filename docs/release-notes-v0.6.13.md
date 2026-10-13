# DevSpace-Forge v0.6.13

v0.6.13 is the complete cross-platform public release for the modern Windows control-plane changes prepared in v0.6.12. It also fixes the Linux product-package build so it works from a clean GitHub runner.

The immutable `v0.6.12` tag remains as a historical release attempt. Its Windows packaging job succeeded, but the Linux product-package job stopped before a complete GitHub Release could be published because the Control UI build ran without first installing `control-ui` dependencies. v0.6.13 fixes that release-path defect instead of moving or rewriting the old tag.

## Highlights

- **Modern Windows control ownership:** one modern Desktop launcher coordinates the local Control console, Runtime and Tunnel, replacing legacy launcher ownership during upgrades.
- **Production Desktop uses the mature Console:** the Desktop now opens the complete loopback Control Console at `/` by default; the incomplete `/next/` React UI remains available only as a development preview.
- **Tray-first desktop lifecycle:** closing the Desktop window hides it to the Windows system tray; an explicit tray **Exit** action performs the real application quit.
- **Quiet background startup:** the launcher starts the Control PowerShell process hidden so normal background operation does not leave a terminal window on screen.
- **Correct multi-instance identity:** Windows Control derives its instance name from the configured public route instead of assuming a fixed deployment name.
- **Windows offline-package hardening:** Runtime and video dependencies are staged through bounded short paths before packaging and smoke tests.
- **Clean Linux packaging:** `package-release-linux.sh` now runs `npm ci` for the Control UI before building it, making the release package independent of leftover local `node_modules` state.
- **Regression coverage:** the packaging test now requires the Linux dependency install to happen before the Control UI build.
- **Media delivery validation:** image-generation workflows verify that generated media is actually delivered through the supported media path.
- **Public-repository privacy guard:** tracked public files and HEAD metadata continue to reject private deployment identifiers, local-machine paths, real credentials and personal Git email addresses.

The embedded Runtime remains pinned to `1.1.0-beta.4.local.15` and ships inside the same Windows/Linux product packages.

## Upgrade

1. Back up the current installation and confirm no active task will be interrupted.
2. Download the v0.6.13 package for the target platform together with its SHA-256 sidecar.
3. Verify the archive checksum before extracting it.
4. Run the normal Windows or Linux update flow.
5. Verify local Control, Runtime, MCP connectivity and Tunnel health before removing the previous rollback copy.

---

# DevSpace-Forge v0.6.13 中文说明

v0.6.13 是这批 Modern Windows control-plane 改动的完整双平台公开版本，同时修复 Linux 产品包在干净 GitHub runner 上无法完成构建的问题。

不可变的 `v0.6.12` tag 会保留为历史发行尝试。该版本的 Windows 打包 job 已成功，但 Linux 产品包在构建 Control UI 前没有先安装 `control-ui` 依赖，因此没有形成完整 GitHub Release。v0.6.13 通过新的 patch 版本修复发行链路，不移动也不改写旧 tag。

## 主要变化

- **Windows modern ownership：** 统一由 Modern Desktop launcher 协调本机 Control、Runtime 与 Tunnel，升级时收敛旧 launcher ownership。
- **正式 Desktop 回到成熟 Console：** Desktop 默认打开完整的本机 `/` Control Console；未完成的 `/next/` React UI 继续保留，但只作为开发预览，不再作为正式入口。
- **托盘常驻：** 点击窗口关闭按钮只隐藏到 Windows 系统托盘，只有托盘里的 **Exit** 才真正退出 Desktop。
- **后台静默启动：** launcher 启动 Control PowerShell 时使用隐藏窗口，正常后台运行不再长期显示终端窗口。
- **多实例身份正确继承：** Windows Control 从已配置的公网路径解析 instance，不再假设固定部署名。
- **Windows 离线包增强：** Runtime 与视频依赖在有界短路径 staging 中完成打包与 smoke，降低长路径和原生依赖问题。
- **Linux 干净环境打包：** `package-release-linux.sh` 在构建 Control UI 前主动执行 `npm ci`，不再依赖本机残留的 `node_modules`。
- **回归门禁：** packaging test 明确要求 Linux 的依赖安装必须发生在 Control UI build 之前。
- **媒体交付验收：** 图片生成后继续检查是否真正通过支持的媒体路径交付。
- **公开仓库隐私门禁：** 继续阻止真实部署标识、本机路径、凭据和个人 Git 邮箱进入公开 tracked 内容与 HEAD metadata。

内嵌 Runtime 仍固定为 `1.1.0-beta.4.local.15`，并继续与 Windows/Linux 产品包一起发行。

## 升级步骤

1. 先备份当前安装，并确认没有会被打断的活动任务。
2. 下载目标平台的 v0.6.13 安装包和对应 SHA-256 文件。
3. 解压前先核对校验值。
4. 按 Windows 或 Linux 的正常更新流程执行升级。
5. 确认本地 Control、Runtime、MCP 连接与 Tunnel 均健康后，再清理旧 rollback 副本。
