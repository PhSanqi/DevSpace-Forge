# DevSpace Control Platform: Windows and Linux

[中文说明](#中文说明)

This repository intentionally uses separate implementation lines for Windows
and Linux because the two environments need different control surfaces and
different upgrade mechanics.

## Platform map

| Platform | Branch | Implementation | Primary responsibility |
| --- | --- | --- | --- |
| Windows | `main` | C# / WinForms control application | Desktop UI, tray, runtime/tunnel supervision, config/history/review presentation |
| Linux | `linux/context-intelligence` | DevSpace runtime branch plus Linux control integration | systemd supervision, upstream-aligned runtime, compact context/output, semantic code navigation |

The branches share product invariants rather than source layout:

- explicit Allowed Roots;
- subagents disabled in the current personal-control scope;
- protected Cloudflare tunnel credentials;
- observable local/public MCP health;
- reversible runtime upgrades and retained rollback points;
- DevSpace upstream security and workspace contracts take precedence over local overlays.

## Windows line

`main` is the Windows product line. It remains a small control plane around
DevSpace rather than a DevSpace source fork. The current implementation owns:

- WinForms UI and tray behavior;
- start/stop/restart supervision;
- Cloudflare Remote Tunnel integration;
- DevSpace 1.0.x / 1.1.x configuration adaptation;
- diagnostics, tool-call logs, configuration history, and review/rollback UI.

Windows build/release instructions remain in the root README.

## Linux line

`linux/context-intelligence` tracks DevSpace source history because Linux
runtime changes need to be rebased against upstream security, MCP, workspace,
and review behavior. Its current baseline is `1.1.0-beta.3+local.7`.

The Linux overlay adds or preserves:

- lazy path-scoped `AGENTS.md` / `CLAUDE.md` context loading;
- bounded `read` and `context_pack` output;
- Serena/LSP symbol navigation through `semantic_code`;
- exact source slicing from semantic `body_location` data;
- compact process output with full local `run_id` evidence retention;
- Linux PTY fallback when upstream `node-pty` has no usable ABI-compatible binary;
- compatibility for older clients that cached camelCase MCP arguments;
- upstream fixes for symlink containment, unborn-repository reviews, and
  non-zero process logging.

See the Linux branch's `DEVCONTROL-LINUX.md` and
`docs/context-intelligence.md` for the complete maintenance rules.

## Sources and attribution

Official DevSpace remains the primary upstream:

- [Waishnav/devspace](https://github.com/Waishnav/devspace)

The Linux context/semantic work also references:

- [yuezhihuafou/devspace-verge](https://github.com/yuezhihuafou/devspace-verge)

`devspace-verge` is an important reference for compact model-visible command
output and workspace-scoped Serena semantic querying. The Linux branch does not
wholesale replace official DevSpace with Verge; it keeps an intentionally small
overlay so upstream DevSpace remains rebaseable and auditable.

---

## 中文说明

这个仓库故意把 Windows 和 Linux 分成不同实现线，因为两种环境需要不同的
控制界面、运行方式和升级机制。

| 平台 | 分支 | 实现方式 | 主要职责 |
| --- | --- | --- | --- |
| Windows | `main` | C# / WinForms | 桌面 UI、托盘、Runtime/Tunnel 监督、配置/历史/Review 展示 |
| Linux | `linux/context-intelligence` | DevSpace Runtime 分支 + Linux 控制层 | systemd、紧跟上游 Runtime、上下文压缩、符号化查询 |

两条分支共享的是产品约束，而不是目录结构：Allowed Roots 明确限制、当前范围
保持 Subagents 关闭、Tunnel secret 独立保护、本地和公网 MCP 状态可观察、
升级可回滚，并且发生冲突时优先采用官方 DevSpace 的安全与 Workspace contract。

### Windows

`main` 是 Windows 产品线。它仍然是围绕 DevSpace 的小型控制层，而不是
DevSpace 源码 Fork，负责 WinForms、托盘、进程监督、Cloudflare、版本配置适配、
诊断、日志、配置历史和 Review / rollback UI。

### Linux

`linux/context-intelligence` 直接跟踪 DevSpace 源码历史，因为 Linux Runtime 的
安全、MCP、Workspace、Review 修改需要持续和上游 rebase。当前基线是
`1.1.0-beta.3+local.7`。

主要增强包括 lazy path context、bounded read / `context_pack`、Serena/LSP
`semantic_code`、符号源码精确切片、compact process output + `run_id` 完整证据、
Linux PTY fallback、旧 camelCase MCP 会话兼容，以及 beta3 之后与 Linux 相关的
官方安全和可观察性修复。

### 引用来源

- 官方基线：[Waishnav/devspace](https://github.com/Waishnav/devspace)
- 上下文 / 语义查询重要参考：[yuezhihuafou/devspace-verge](https://github.com/yuezhihuafou/devspace-verge)

`devspace-verge` 主要提供 compact model-visible command output 和 workspace-scoped
Serena semantic backend 的重要参考。本项目没有整仓替换官方 DevSpace，而是保持
一个尽可能小的 overlay，确保 Linux 版本仍可以持续跟随和审计官方上游。
