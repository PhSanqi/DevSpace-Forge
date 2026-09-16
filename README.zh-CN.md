# DevSpace Control Platform

[English](README.md)

DevSpace Control Platform 是一个跨平台的 DevSpace 控制项目，用于管理本地 [DevSpace](https://github.com/Waishnav/devspace) 实例以及对应的 Cloudflare Tunnel。

当前仓库明确分成两条实现线：

- **Windows：** 当前 `main` 分支，WinForms 桌面控制程序。
- **Linux：** [`linux/context-intelligence`](https://github.com/PhSanqi/DevSpaceControlPlatform/tree/linux/context-intelligence) 分支，直接围绕 DevSpace Runtime、systemd 控制、上下文压缩以及 Serena 符号化查询维护。

两条实现线的职责、共同约束和引用来源见 [PLATFORMS.md](PLATFORMS.md)。

目标是把 DevSpace 从一组命令行配置和后台进程，整理成一个可以长期常驻、可观察、可回滚的普通桌面程序。

## 主要功能

- DevSpace 与 Cloudflare 可分别启动、停止、重新启动。
- 托盘常驻与后台进程监督。
- 针对已验证的 DevSpace 1.0.x / 1.1.x 配置体系进行版本感知适配。
- 管理 Allowed Roots、Tool mode、Skills、日志与有效配置。
- Cloudflare Remote Tunnel Token 使用独立受保护文件保存，不进入普通配置和历史记录。
- UI 内直接运行 `doctor`、查看有效配置。
- GPT 工具调用日志按照 DevSpace `workspaceId` 隔离，并与基础设施日志分开。
- 每个 Git 项目维护独立的 `show_changes` 代码版本历史。
- 支持一次回滚多个 Review 版本，并通过安全检查避免覆盖后续修改。
- ControlPlatform 自身配置另有独立的配置历史。

当前产品范围内明确保持 Subagents 关闭。

## 代码版本管理

每个 Git 项目都有自己的版本链：

```text
项目 A：V0 -> V1 -> V2 -> V3
项目 B：V0 -> V1
```

每次观察到 DevSpace `show_changes` 后，ControlPlatform 会记录一个隐藏 Git 快照，并保存一条简短的“问题 / 动机；处理结果”说明。

可以直接选择较早的活动版本，一次回滚中间多个 Review。回滚前会先验证反向补丁是否仍可安全应用；如果之后已有冲突修改，程序会拒绝自动覆盖，而不是执行 `git reset --hard`。

不同 GPT 对话则按照 DevSpace `workspaceId` 独立记录日志，因此即使多个对话同时操作同一个项目，后台工具调用也不会混在一起。

## Cloudflare 连接方式

推荐使用 remotely-managed Cloudflare Tunnel：

```text
ChatGPT / MCP 客户端
        |
        v
Cloudflare hostname
        |
        v
cloudflared
        |
        v
127.0.0.1:<DevSpace 端口>/mcp
```

Tunnel Token 保存在本地受保护 secrets 文件中，不进入 `settings.json`、配置历史或 Git。

## 构建

当前 Windows 桌面程序使用系统中的 .NET Framework C# 编译器构建：

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

输出：

```text
bin\DevSpaceControlPlatform.exe
```

仓库不会提交本机 managed runtime / state，包括：

```text
runtime/
state/
logs/
bin/
```

## 安装 Release

1. 从 GitHub Releases 下载并解压 `DevSpaceControlPlatform-vX.Y.Z-win-x64.zip`。
2. 在解压目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-runtime.ps1
```

3. 启动 `DevSpaceControlPlatform.exe`。
4. 添加 DevSpace 可以访问的项目目录，设置本地端口和 Cloudflare Remote Tunnel hostname。
5. 第一次把 Tunnel Token 粘贴到受保护的 Token 输入框并保存即可。

轻量 Release 不内置 Node.js、DevSpace、cloudflared，也不包含机器配置、日志、OAuth 状态或 Tunnel secret。`setup-runtime.ps1` 会在本机下载并校验固定版本的运行时组件。

## 与上游 DevSpace / Linux 上下文增强的关系

本项目是建立在 DevSpace 之上的控制层，但**不是 DevSpace 源码本身的 Fork**。

- 上游项目：[Waishnav/devspace](https://github.com/Waishnav/devspace)
- DevSpace 负责 MCP Server、Workspace 生命周期、工具、Review checkpoint、Skills 和运行时行为。
- DevSpace Control Platform 负责 Windows 控制界面、进程监督、Tunnel 集成、版本配置适配、诊断以及本地 Review / 回滚展示。

Linux 分支的实现方式不同：它需要紧跟 DevSpace Runtime，因此在官方 DevSpace 基线上维护小范围、可重放的增强层。上下文与语义查询方向同时明确参考了 [yuezhihuafou/devspace-verge](https://github.com/yuezhihuafou/devspace-verge)，特别是“模型只看到有界命令输出、完整证据保留在本地”以及“workspace-scoped Serena semantic backend”两类思路。安全、MCP、Workspace 生命周期和正式版本仍以官方 DevSpace 为 source of truth。

开发时使用的 `upstream/devspace` 只是只读参考源码，并且明确排除在本仓库之外。

## 当前范围

`main` 分支面向 Windows；Linux 实现独立维护在 `linux/context-intelligence`，这样可以在不把 C# 桌面控制器和 Runtime 源码混在同一目录树的前提下持续跟进上游。两条实现线都不尝试重新实现整套 DevSpace，也不打算成为第二套 Agent Harness。

核心原则是：在尽量少增加额外复杂度的前提下，把 DevSpace 的能力变得更容易配置、更透明、更容易恢复。

