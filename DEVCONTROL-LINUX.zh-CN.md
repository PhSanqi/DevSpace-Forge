# DevSpaceControlPlatform — Linux Runtime 分支

[English](DEVCONTROL-LINUX.md)

这个分支属于
[PhSanqi/DevSpaceControlPlatform](https://github.com/PhSanqi/DevSpaceControlPlatform)
的 Linux 实现线。它与 Windows `main` 分支故意采用不同源码结构：Windows
版本是 C# 桌面控制器，而 Linux 版本需要紧跟 DevSpace Runtime，本分支因此
直接以官方 DevSpace 为基线维护少量可重放的增强层。

## Windows / Linux 分工

| 平台 | 分支 | 当前版本 | 主要职责 |
| --- | --- | --- | --- |
| Windows | `main` | `v0.2.0` | WinForms 控制界面、运行时监督、Cloudflare、配置历史、Review / 回滚展示 |
| Linux | `linux/context-intelligence` | `1.1.0-beta.3+local.7` | systemd 管理的 DevSpace Runtime / 控制层，以及上下文与语义查询增强 |

两条实现线保持相同原则：Allowed Roots 明确限制、运行状态可观察、升级可回滚、
Tunnel 凭据独立保护，并且当前个人控制范围内保持 Subagents 关闭。

## 当前 Linux 基线

- Runtime：`1.1.0-beta.3+local.7`
- 官方基线：`Waishnav/devspace` `v1.1.0-beta.3`
- Node：22.x；当前已验证 Node 22.23.2 / ABI 127
- Serena：已验证 1.7.0
- 服务监督：Linux DevSpace Control + user systemd service
- 公网连接：Cloudflare Tunnel -> `127.0.0.1:<port>/mcp`

当前增强内容包括：

- 官方 canonical path / symlink escape 安全修复；
- 按目标路径惰性加载 `AGENTS.md` / `CLAUDE.md`；
- 带硬字符预算的 `context_pack`；
- Serena/LSP 支持的 `semantic_code`；
- 根据语义 `body_location` 精确读取符号源码片段；
- `read` 默认有界输出，并优先引导模型进行符号化查询；
- 命令只向模型返回 compact preview，完整 stdout/stderr 按 `run_id` 本地保存；
- `devspace-log meta/read/tail/grep`；
- 官方 `node-pty` 无可用 Linux native binary 时的 ABI 127 预编译 PTY fallback；
- 旧 ChatGPT 长会话缓存 camelCase MCP 参数时的兼容归一化；
- 无 `HEAD` 的新 Git 仓库也可以正常做 `show_changes`；
- 非零进程退出在工具日志中明确标记失败原因和 exit code。

具体设计和升级约束见
[docs/context-intelligence.md](docs/context-intelligence.md)。

## 上游和引用来源

官方 DevSpace 始终是本分支的 source of truth：

- 官方仓库：[Waishnav/devspace](https://github.com/Waishnav/devspace)
- 当前基线：`v1.1.0-beta.3`

上下文优化同时明确参考了
[yuezhihuafou/devspace-verge](https://github.com/yuezhihuafou/devspace-verge)，
特别是两类思路：

1. 对模型只返回压缩后的命令输出，同时把完整证据保存在本地；
2. 使用 workspace-scoped Serena backend 提供符号化 / 语义查询。

本分支**不是**把官方 DevSpace 整体替换为 `devspace-verge`。Provider、MCP
生命周期、安全边界、Workspace 行为和后续版本升级仍以官方 DevSpace 为准，
这里只维护当前控制环境需要的上下文与语义增强层。

beta3 之后已经额外同步的 Linux 相关官方修复包括：

- `a8e5ee4`：阻止 workspace symlink escape；
- `2147c23`：无 `HEAD` 的仓库也支持 change review；
- `8e4669c`：非零进程退出写入明确的 tool log 元数据。

仅影响 Windows / macOS native artifact download 的上游提交没有为了“追提交数量”
而强行并入 Linux Runtime。

## 当前验证状态

`local.7` 已完成：

- TypeScript typecheck；
- 完整源码测试：`157 passed / 0 failed / 1 skipped`；
- 真实 Serena 符号 / Context Pack 查询；
- bounded context 与 compact log 按需读取；
- 本地 / 公网 MCP 鉴权探测；
- PTY spawn / 输入 / resize / exit；
- 旧 camelCase MCP 会话兼容；
- unborn Git repository `show_changes`；
- 非零进程退出日志。

## 长期维护原则

这不是要维护第二套独立 DevSpace 产品。官方发布新版本时：

1. 先同步安全、Workspace、MCP、Review 等上游修改；
2. 发生冲突时优先采用 upstream contract；
3. 只重新应用最小范围的 context / semantic / Linux runtime compatibility；
4. 完整运行测试和真实 Runtime smoke；
5. 使用并行 Runtime 做切换，并保留旧 Runtime 作为即时回滚点。

目标是让 Linux DevSpace 适合长期 AI Coding 会话，同时持续保持回到官方主线的能力。
