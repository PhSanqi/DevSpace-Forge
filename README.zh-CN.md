# DevSpace-Forge

[English](README.md) · [安装指南](docs/getting-started.md) · [发行与升级](docs/releases-and-upgrades.md)

**留在当前对话，在自己的电脑上开发。**

DevSpace-Forge 通过 MCP 将支持该协议的 AI 聊天客户端连接到你授权的 Windows 或 Linux 开发目录。讨论需求、查看仓库、修改文件、运行测试、检查结果，都可以沿着当前对话继续，而不必反复在聊天、编辑器和终端之间复制代码和重新解释。

这是社区自托管项目，不是 OpenAI 或 Cloudflare 的官方产品。客户端功能、上下文保留能力和使用额度由相应产品及套餐决定。DevSpace-Forge 不赠送 AI 额度、不绕过限制，也不承诺无限记忆。

## 主要功能

- **在 Chat 中调用本地开发工具：** 按授权范围读写文件、执行命令、构建、测试和 Git 操作。
- **本地图片理解与可视化回传：** `read_image` 可读取一张工作区 JPG/PNG，`read_images` 可同时比较最多八张图片。工具返回真正的 MCP `ImageContent`，而不是把 base64 塞进文本；启用 MCP Apps UI 时，DevSpace 还会把同一份真实返回像素直接显示在媒体卡片中，因此“看一下 / 展示 / 发给我”不再依赖模型用文字或 HTML 重构图片。超大或超长图片会先在本机转换为有界 overview + detail tiles。
- **自适应视频理解：** `read_video` 会把工作区视频采样为带时间戳的 MCP 图片帧。模型可先做全视频粗采样，再根据连续性缺口、文字变化或不确定片段对指定时间区间再次调用 `read_video` 加密采样；启用 MCP Apps UI 时，这些采样帧也会直接显示在同一媒体卡片中。每次最多返回八帧，不通过 MCP 传输原始视频文件。
- **减少上下文交接：** 将项目文件、Git 状态和执行结果带回同一条对话；实际上下文窗口仍由客户端决定。
- **目录权限边界：** 使用 Allowed Roots 明确可访问的目录。
- **检查与恢复：** 查看改动、命令证据、Review 检查点、持久任务状态和日志。
- **Windows / Linux：** 提供包含固定版本 Runtime、Node.js 和 cloudflared 的 x64 离线包。
- **可选远程连接：** 使用你自己的 Cloudflare Tunnel。高权限管理 Console 仅在本机访问，不是公网控制台。

标准 MCP 图片内容仍然是模型输入与兼容路径。启用 MCP Apps UI 时，`read_image`、`read_images`、`read_video` 会额外把同一份返回像素显示在 DevSpace 媒体卡片中，且不会把图片 base64 再复制进 structured output。若客户端既不支持 MCP Apps，也不支持原生 MCP 图片渲染，图片仍可能只进入模型而不在聊天界面内联显示。`read_video` 现在可见的是采样帧，不是完整视频播放器；音频转写和视频播放仍属于独立能力。

## 快速开始

从仓库的 **Releases** 页面下载最新版安装包及对应 SHA-256 校验文件。

Control 与内嵌 Runtime 从同一个 `main` revision 构建，并随同一条公开产品 Release 一起发布；无需再单独匹配 Runtime 与 Control 版本。

| 平台 | 文件名形式 | 安装入口 |
| --- | --- | --- |
| Windows x64 | DevSpace-Forge-vX.Y.Z-win-x64.zip | 解压后运行 Setup.exe |
| Linux x64 | DevSpace-Forge-vX.Y.Z-linux-x64.tar.gz | 解压后运行 ./setup-linux.sh |

1. 按配套的校验文件验证安装包。
2. 指定允许访问的项目目录和本地 MCP 端口。
3. 如需远程使用，在**自己的** Cloudflare 账户创建 remotely managed Tunnel，将 public hostname 指向安装器显示的本地 Origin。
4. 在支持 MCP 的客户端连接安装器给出的 HTTPS /mcp 地址，并在本地完成首次 Owner 授权。
5. 让 AI 打开项目、修改少量文件、执行测试并展示差异。

示例地址：https://workspace.example.com/mcp，仅作格式说明，并非本项目提供的服务。不要将真实 Tunnel token、密码或 API 凭据写入 Git、发在截图或提交到 Issue。建议使用交互式方式填写 Token，避免留在 shell 历史中。

完整操作请参阅[安装与 MCP 连接](docs/getting-started.md)。

## 工作原理与安全

Runtime 在你自己的机器上执行；Windows 管理器或 Linux 本地 Console 管理服务，可选 Tunnel 仅转发所配置的 MCP 端点。项目、凭据、状态和命令日志保存在本机，AI 只应访问你授权的目录与工具。危险操作前请检查改动。

多实例网关是普通安装之外的可选组件，真实 origin hostname 通过部署环境传入，不应硬编码到公开仓库。参见[网关示例](ops/CLOUDFLARE-GATEWAY.md)。

site 目录是可选的公开静态介绍站，**不是**管理 Console 或 MCP Endpoint。网站域名与仓库地址在部署时配置；源码只包含可复用模板。参见[自托管产品主页](docs/public-website.md)。

## 文档

- [安装与 MCP 连接](docs/getting-started.md)
- [平台和发行包](PLATFORMS.md)
- [版本、校验与安全升级](docs/releases-and-upgrades.md)
- [图片与上下文智能](runtime-src/docs/context-intelligence.md)
- [自适应视频理解](runtime-src/docs/video-understanding.md)
- [本地管理 Console](docs/runtime-console.md)
- [可选产品主页](docs/public-website.md)
- [产品路线图](ROADMAP.md)

## 上游与许可

本项目基于开源 DevSpace 生态，包括 [Waishnav/devspace](https://github.com/Waishnav/devspace) 和 [devspace-verge](https://github.com/yuezhihuafou/devspace-verge)。固定并集成后的 Runtime 源码直接保存在 [`runtime-src/`](runtime-src/)；Windows/Linux 产品包与 Runtime 都从同一个 `main` revision 构建，不再维护单独的公开 Runtime 分支或 Runtime Release。本仓库的发行与集成内容遵循 [MIT License](LICENSE)，上游项目保留各自的版权与许可证。
