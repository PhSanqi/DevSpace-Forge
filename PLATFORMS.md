# DevSpace Control Platform platform map

## Current versions

| Platform / component | Branch | Version |
| --- | --- | --- |
| Windows Control Platform | `main` | `v0.3.0` |
| Windows DevSpace runtime | `runtime/beta4-unified` | `1.1.0-beta.4.local.10` |
| Linux DevSpace runtime/control | `runtime/beta4-unified` | `1.1.0-beta.4.local.10` |

The Windows and Linux runtime branches share the same `local.7` Context Intelligence baseline: canonical workspace containment, lazy path-scoped instructions, `context_pack`, Serena semantic queries, bounded reads, compact `run_id` evidence, cached camelCase client compatibility, unborn-repository reviews, and explicit non-zero process logging.

Windows additionally carries official upstream commit `eaf8f3e` for native artifact downloads. Linux keeps its own PTY fallback; Windows deliberately does not import that Linux-specific layer.

## Source relationships

- Primary upstream: [Waishnav/devspace](https://github.com/Waishnav/devspace)
- Context/runtime reference: [yuezhihuafou/devspace-verge](https://github.com/yuezhihuafou/devspace-verge)
- Serena: [oraios/serena](https://github.com/oraios/serena)

`devspace-verge` is a reference for compact output and Serena integration, not the replacement upstream. Official DevSpace contracts remain authoritative.

## Windows installation model

The `v0.3.0` Windows release remains lightweight. Core runtime setup and Serena setup are separate. Existing installations use a side-by-side runtime-slot workflow: prepare and validate a new slot while the current instance remains online, inject the pinned Koffi 3.2.1 Windows native dependency, verify Serena 1.7.0 semantically, then switch a small `active-slot.txt` pointer at cutover time. The final cutover/rollback scripts are offline and fail closed. Runtime/state/secrets remain local and are not committed to Git.

## 中文说明

- Windows 控制器：`main` / `v0.3.0`
- Windows Runtime：`runtime/beta4-unified` / `1.1.0-beta.4.local.10`
- Linux Runtime：`runtime/beta4-unified` / `1.1.0-beta.4.local.10`

Windows 和 Linux 共享 `local.7` Context Intelligence；Windows 额外包含官方 Windows native artifact 修复，Linux 则保留 Linux 专用 PTY fallback。Windows `v0.3.0` 对已有实例默认采用旁路 Runtime slot：在线准备、独立验证、指针切换、可立即回滚。`devspace-verge` 是 compact output 和 Serena 语义层的重要参考，但官方 DevSpace 仍是主上游。
