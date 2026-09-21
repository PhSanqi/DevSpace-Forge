# DevSpace Control Platform

[English](README.md)

DevSpace Control Platform 用来把一台 Windows 或 Linux 电脑变成 ChatGPT 可以长期使用的本地 Coding Workspace。下载一个 Release，指定允许访问的项目目录，接一个 Cloudflare Tunnel，就可以让 ChatGPT 通过 MCP 使用你自己的文件、Git 仓库、终端、构建工具和本地运行环境。

项目文件和运行数据仍然保存在你的电脑上。真正暴露到公网的，是你主动通过 Tunnel 提供的 MCP Endpoint。

本项目建立在 DevSpace 生态之上，Runtime 方向持续参考和维护于 [Waishnav/devspace](https://github.com/Waishnav/devspace) 与 [yuezhihuafou/devspace-verge](https://github.com/yuezhihuafou/devspace-verge)。详细说明见后面的[上游项目](#上游项目)。

## 能做什么

- **Windows / Linux 都提供完整离线成品包。** Release 内已经带 Node.js、DevSpace Runtime 和 cloudflared，最终用户安装时不需要再跑 npm 安装 Runtime 依赖。
- **Cloudflare 配置集中完成。** 选择本地端口，填 public hostname 和 Remote Tunnel token，安装器会直接给出 Cloudflare 应连接的本地 Origin、本地 MCP 和公网 MCP 地址。
- **让 ChatGPT 真正操作自己的本地项目。** 可以读取、搜索、编辑、新建文件，也可以运行本机 shell、测试、构建、Git、package scripts 和项目自己的工具链。
- **Allowed Roots。** ChatGPT 只能打开你明确授权的目录范围。
- **项目归属与 workspace 分开判断。** 模型不会因为“打开了一个目录”就把它直接当成项目，而是先判断真正的 repository / project root。
- **没有 Git 时按真实项目边界初始化。** 如果项目确实没有仓库，要求模型在正确项目根目录 `git init`，而不是在随便一个父目录或嵌套目录建 Git。
- **Windows 管理界面直接查看真实 Git。** 可以看到 repository root、branch、HEAD、dirty/clean 状态和最近 commits。
- **独立 Review 历史与安全回滚。** DevSpace Review checkpoint 不等同于 Git commit，可以用于检查和回滚，不需要粗暴执行 `git reset --hard`。
- **长命令完整证据保存在本机。** 模型只收到有界输出和 `run_id`，完整日志可以之后 read / tail / grep，不会因为一次构建输出几万行就把上下文塞满。
- **Runtime 诊断和恢复。** 可以查看健康状态、有效配置、`doctor` 信息，进行服务重启、旁路 Runtime slot 验证与回滚。
- **可选 Serena / LSP 语义源码导航。** 需要更强 symbol-level 导航时可以安装 Serena，但不是基本运行所必需。
- **不会自动 push。** 项目 Git 默认只在本地工作，除非你明确要求模型推送远端。
- **当前 Control 产品范围继续关闭 Subagents。**

## 最快的使用流程

正常只需要四步：

1. 下载并解压对应系统的 Release。
2. 选择允许访问的项目目录和本地 DevSpace 端口。
3. 在 Cloudflare 网页创建一个 **remotely-managed Tunnel** 和 public hostname，把它指向安装器显示的本地 Origin，通常是 `http://127.0.0.1:7677`。
4. 把 hostname 和 Tunnel token 填回 DevSpace Control Platform，然后让 ChatGPT 或其它 MCP Client 连接 `https://你的域名/mcp`。

第一次客户端连接还需要使用安装器生成的 Owner password 完成授权。

不需要 Cloudflare API Key。Control Platform 不会替你修改 Cloudflare 账号资源；Cloudflare 侧唯一需要手工做的，就是创建 Tunnel / public hostname，然后复制它的 token。

## Windows

下载：

```text
DevSpaceControlPlatform-vX.Y.Z-win-x64.zip
```

解压后直接运行：

```text
Setup.exe
```

Windows ZIP 是完整离线 Runtime 包。`Setup.exe` 会自动展开包内 Runtime，然后要求填写：

- ChatGPT 可以访问的本地项目目录；
- 本地 DevSpace 端口，通常使用 `7677`；
- Tunnel 名称，可选，只用于本地标记；
- Cloudflare Tunnel origin hostname，例如 `personal-origin.sanqi.org`；
- 可选的统一公网 endpoint，例如 `dev.sanqi.org/personal`。留空时直接使用 Tunnel origin hostname；
- Cloudflare Remote Tunnel token。

保存之前，Setup 会直接显示：

```text
Cloudflare 本地 Origin   http://127.0.0.1:7677
本地 MCP                 http://127.0.0.1:7677/personal/mcp
公网 MCP                 https://dev.sanqi.org/personal/mcp
```

多机器通过统一域名按路径暴露时，Tunnel origin hostname 与统一公网 endpoint 是两个值。例如 Cloudflare Published Application 使用 `personal-origin.sanqi.org -> http://127.0.0.1:7677`，而 MCP 客户端使用 `https://dev.sanqi.org/personal/mcp`。Setup 会自动把 origin hostname 写入 DevSpace `allowedHosts`，并把统一 endpoint 写成 canonical public base。

配置完成后会启动 `DevSpaceControlPlatform.exe`，之后由 Control 统一管理 DevSpace 和 cloudflared。Tunnel token 独立保存，不进入普通 settings 历史和项目 Git。

### Windows 日常怎么用

平时打开 Control Platform 就可以查看和管理：

- DevSpace / Cloudflare 的启动、停止和重启；
- 本地 MCP 和公网 MCP 地址；
- 当前有效配置、Runtime 健康状态和诊断信息；
- 最新工具调用和完整命令证据；
- 项目归属、Git repository、branch、HEAD、dirty 状态和最近 commits；
- DevSpace Review 历史以及受支持的回滚操作。

## Linux

当前成品目标：**Linux x86_64**。

下载并解压：

```text
DevSpaceControlPlatform-vX.Y.Z-linux-x64.tar.gz
```

然后运行：

```bash
./setup-linux.sh
```

Linux Release 同样已经包含 Node.js、经过验证的 DevSpace Runtime 和 cloudflared，安装时不会再下载这些 Runtime 依赖。

交互安装会询问 Allowed Root、本地端口、Cloudflare public hostname 和 Tunnel token。也可以一次性通过参数传入：

```bash
./setup-linux.sh \
  --allowed-root "$HOME/projects" \
  --port 7677 \
  --public-url "https://devspace.example.com" \
  --tunnel-token "YOUR_TUNNEL_TOKEN"
```

安装完成后会直接打印本地 Origin、本地 MCP、公网 MCP 和 Owner password，并安装两个 user service：

```text
devspace-control.service
devspace-control-cloudflared.service
```

常用命令：

```bash
systemctl --user status devspace-control.service
systemctl --user status devspace-control-cloudflared.service
systemctl --user restart devspace-control.service
systemctl --user restart devspace-control-cloudflared.service
```

`setup-linux.sh` 可以重复运行，用于更新本机配置和 service 文件。

## Cloudflare 到底要填什么

使用 remotely-managed Tunnel 时：

| 内容 | 从哪里得到 | 示例 |
| --- | --- | --- |
| 本地 Origin | DevSpace Control Platform 显示 | `http://127.0.0.1:7677` |
| Public hostname | 你在 Cloudflare 创建 | `devspace.example.com` |
| 公网 MCP | Control 自动推导 | `https://devspace.example.com/mcp` |
| Tunnel token | Cloudflare remotely-managed Tunnel | 作为本地受保护 secret 保存 |

Cloudflare 的 public hostname 要指向**本地 Origin**，不要把 `/mcp` 写到 Origin 里；真正给 ChatGPT / MCP Client 使用的是完整公网 `/mcp` 地址。

## 在 ChatGPT 里怎么用

服务和 Tunnel 都启动后：

1. 在你使用的 ChatGPT App / connector / 自定义 MCP 流程中加入公网 MCP Endpoint：`https://你的域名/mcp`。
2. 第一次连接时用 Setup 生成的 Owner password 完成授权。
3. 让 ChatGPT 打开 Allowed Root 内的某个项目。
4. 之后可以正常要求它检查代码、修改文件、运行测试和构建、查看 Git、或者检查这次到底改了什么。

例如：

> 打开 `C:\Users\me\projects\my-app`，检查这个仓库，修复失败的测试，跑完整测试，然后告诉我改了什么。

模型会收到项目边界规则，因此会区分“DevSpace 当前打开的 workspace”和“真正属于这个项目的 Git repository”。

## 项目归属与本地 Git

Control Platform 明确区分三个概念：Allowed Root、当前打开的 workspace、真正的 project / repository。

已有 Git 时，模型要求以 `git rev-parse --show-toplevel` 的结果作为 canonical Git project root。没有 Git 时，先判断项目真正边界，再在那个位置初始化仓库。

这样可以避免把 `projects/` 这种项目集合目录错误初始化成一个大仓库，也避免在某个随机子目录里创建 Git。Windows Control UI 显示的也是最终判断出的真实 repository。

DevSpace Review 历史与 Git 是两条独立记录。Review checkpoint 用于检查和恢复，不替代你平时正常的 Git commit。

## 日志与长时间任务

大型命令的完整输出保存在本机，不会全部塞进模型上下文。模型拿到的是有界 preview 和稳定的 `run_id`，之后可以按需读取：

```text
devspace-log read <runId> 1 80
devspace-log tail <runId> 80
devspace-log grep <runId> <pattern>
devspace-log meta <runId>
```

这特别适合构建、依赖安装、编译器、测试、烧录工具等输出很长、但又需要保留完整证据的任务。

## 安全建议

- Allowed Roots 尽量只授权真正需要的项目目录。
- 把公网 MCP URL 和 Owner password 当作高权限本地开发入口来保护。
- Cloudflare Tunnel token 不写入项目文件和普通配置历史。
- MCP 服务只在本机监听，通过你自己控制的 Tunnel 暴露。
- 重要仓库在 commit / push 前仍建议检查本地 diff。

## 常见排查顺序

如果 ChatGPT 连不上：

1. 先确认 DevSpace 正在运行，本地 MCP 可以访问。
2. 再确认 cloudflared 正在运行。
3. 检查 Cloudflare public hostname 是否指向 Control 显示的准确本地 Origin。
4. 检查配置里的 public hostname 与 MCP Client 使用的域名是否一致。
5. 检查第一次 Owner password 授权是否已经完成。

Linux 可以用上面的 `systemctl --user status ...`；Windows 直接看 Control Platform 的状态和诊断页。

## 从源码构建

Windows Control 开发：

```powershell
powershell -ExecutionPolicy Bypass -File .\test.ps1
powershell -ExecutionPolicy Bypass -File .\build.ps1
powershell -ExecutionPolicy Bypass -File .\build-setup.ps1
```

Release 打包由 `package-release.ps1`、`package-release-linux.sh` 和 GitHub Actions workflow 处理。普通用户建议直接下载预编译成品包，不需要自己构建 Runtime。

## 上游项目

DevSpace Control Platform 建立在以下上游工作的基础上：

- **[Waishnav/devspace](https://github.com/Waishnav/devspace)** — 原始 MIT 开源 DevSpace，自托管 MCP Coding Harness，负责把允许的本地 workspace、文件操作、shell、Git/worktree、Review 等能力提供给支持 MCP 的 Host。
- **[yuezhihuafou/devspace-verge](https://github.com/yuezhihuafou/devspace-verge)** — 基于 DevSpace 独立维护的 MIT 衍生项目，重点面向长时间 Agent 工作流、有界模型输出、持久 run evidence、上下文质量、语义源码导航和长期部署。
- **[oraios/serena](https://github.com/oraios/serena)** — 安装 Serena 功能时使用的可选语义 / LSP 源码导航后端。

DevSpace Control Platform 不是 DevSpace 或 DevSpace Verge 的官方发行版。本项目主要解决的是 DevSpace Runtime 周边的完整打包、安装、常驻服务控制、Cloudflare 接入、项目 / Git 可见性、诊断、恢复和最终用户低门槛使用体验。

## License

MIT，见 [LICENSE](LICENSE)。
