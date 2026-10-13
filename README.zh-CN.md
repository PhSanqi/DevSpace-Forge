# DevSpace-Forge

[English](README.md) · [安装指南](docs/getting-started.md) · [发行与升级](docs/releases-and-upgrades.md)

**留在当前对话，在自己的电脑上开发。**

DevSpace-Forge 通过 MCP 将支持该协议的 AI 聊天客户端连接到你授权的 Windows 或 Linux 开发目录。讨论需求、查看仓库、修改文件、运行测试、检查结果，都可以沿着当前对话继续，而不必反复在聊天、编辑器和终端之间复制代码和重新解释。

这是社区自托管项目，不是 OpenAI 或 Cloudflare 的官方产品。客户端功能、上下文保留能力和使用额度由相应产品及套餐决定。DevSpace-Forge 不赠送 AI 额度、不绕过限制，也不承诺无限记忆。

## v0.6.12 新增内容

- **Windows 现代控制入口：** Windows 包现在由单一 Modern Desktop launcher 协调本地 Control、Runtime 与 Tunnel；升级后会收敛旧 launcher ownership，不再让新旧两套管理器并行争用。
- **多实例启动更安全：** Windows Control 的 instance 会从已配置的公网 route 推导，不再固定为某个部署名称，因此 `/team-a`、`/team-b` 这类可复用实例可以保持各自身份。
- **Windows 离线打包更稳定：** Runtime 与视频原生依赖在打包和 smoke test 前会经过有界短路径 staging，降低 Windows 长路径与原生依赖处理造成的打包失败。
- **媒体交付验证更严格：** 图片生成类流程现在不仅检查“生成成功”，还会验证生成媒体是否通过支持的媒体路径真正交付。
- **公开仓库隐私收口：** 文档、示例、测试和 Release 元数据统一使用通用占位符与非个人 Git 身份；真实部署域名、凭据和本机路径只保留在用户本地配置中。

升级细节与验收方法见 [v0.6.12 发行说明](docs/release-notes-v0.6.12.md)。

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
2. Windows 运行 `Setup.exe` 后按向导逐步完成：确认自己有可管理的域名，并已把域名加入 Cloudflare。
3. 在 Cloudflare 创建 Tunnel。Setup 会自动显示当前 Windows 架构；在 Cloudflare 选择对应环境后，**直接复制完整的 Install and Run 命令并粘贴到 Setup**，不需要手工从命令里截取 Tunnel token，也不需要自己先安装另一套 cloudflared 服务。
4. 等 Tunnel 显示 Healthy 后，在 Tunnel 的 Routes 中添加 **Published application**。Setup 会明确给出需要填写的本地 Service URL，只需选择自己的子域名/域名并复制该地址。
5. 选择允许 AI 访问的项目目录，然后确认安装。安装完成后，在支持 MCP 的客户端连接 Setup 给出的 HTTPS `/mcp` 地址，并在本地完成首次 Owner 授权。
6. 让 AI 打开项目、修改少量文件、执行测试并展示差异。

示例地址：https://workspace.example.com/mcp，仅作格式说明，并非本项目提供的服务。不要将真实 Tunnel token、密码或 API 凭据写入 Git、发在截图或提交到 Issue。Windows 引导安装会把你粘贴的完整 Cloudflare 命令解析为受保护的本地凭据；正常使用不需要把 token 单独放进 shell 历史。

完整操作请参阅[安装与 MCP 连接](docs/getting-started.md)。

## 工作原理与安全

Runtime 在你自己的机器上执行；Windows 由 Modern Desktop launcher 协调 loopback Control 与托管服务，Linux 由本地 Console 管理实例。可选 Tunnel 仅转发所配置的 MCP 端点。项目、凭据、状态和命令日志保存在本机，AI 只应访问你授权的目录与工具。危险操作前请检查改动。

多实例网关是普通安装之外的可选组件，真实 origin hostname 通过部署环境传入，不应硬编码到公开仓库。参见[网关示例](ops/CLOUDFLARE-GATEWAY.md)。

site 目录是可选的公开静态介绍站，**不是**管理 Console 或 MCP Endpoint。网站域名与仓库地址在部署时配置；源码只包含可复用模板。参见[自托管产品主页](docs/public-website.md)。

## 文档

- [安装与 MCP 连接](docs/getting-started.md)
- [平台和发行包](PLATFORMS.md)
- [版本、校验与安全升级](docs/releases-and-upgrades.md)
- [v0.6.12 发行说明](docs/release-notes-v0.6.12.md)
- [图片与上下文智能](runtime-src/docs/context-intelligence.md)
- [自适应视频理解](runtime-src/docs/video-understanding.md)
- [本地管理 Console](docs/runtime-console.md)
- [可选产品主页](docs/public-website.md)
- [产品路线图](ROADMAP.md)

## 上游与许可

本项目基于开源 DevSpace 生态，包括 [Waishnav/devspace](https://github.com/Waishnav/devspace) 和 [devspace-verge](https://github.com/yuezhihuafou/devspace-verge)。固定并集成后的 Runtime 源码直接保存在 [`runtime-src/`](runtime-src/)；Windows/Linux 产品包与 Runtime 都从同一个 `main` revision 构建，不再维护单独的公开 Runtime 分支或 Runtime Release。本仓库的发行与集成内容遵循 [MIT License](LICENSE)，上游项目保留各自的版权与许可证。
