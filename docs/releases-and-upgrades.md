# Releases and safe upgrades / 发行与安全升级

## Choose and verify a package

Open this repository's Releases tab. Download the Windows x64 ZIP or Linux x64 tar.gz, together with the corresponding SHA-256 sidecar. Before extracting, compare the downloaded archive's SHA-256 to the supplied file.

Control and its embedded Runtime follow separate version lines. Each package includes a provenance manifest that identifies its build and pinned Runtime. A GitHub Release does not update an already running installation.

## Install or update

**Windows:** extract the archive and run Setup.exe. If it detects an existing installation, use its update flow. Confirm the target installation before proceeding.

**Linux:** extract the archive and run ./setup-linux.sh. An existing configuration can be updated in place; use the explicit reconfiguration option only when you intend to change connection settings. Actual systemd unit names depend on your instance name.

Before updating, confirm that your projects and settings are backed up and no active task will be interrupted. Keep the previous working version until the new one passes health, MCP/OAuth and project-access checks. If the update fails, restore the prior installation using the provided rollback path.

Never publish the management Console, Owner password, Tunnel credential, local job store or environment files. Do not paste a real token into a support issue or shell command that will be recorded.

## What you may safely delete

You can remove downloaded archive duplicates and temporary build directories that you have verified are not used. Keep your configured Runtime, state database, workspace files, credentials, and the most recent working rollback until a successful upgrade is confirmed.

The public Git repository and historical release assets are source and distribution records, not your machine's installation inventory. Deleting an old tag does not uninstall an old runtime.

For optional public website hosting see [website setup](public-website.md). For everyday service management see [Console guide](runtime-console.md).

中文摘要：按系统选择离线包并核对 SHA-256；先备份，再检查活动任务，升级后验证本地进程与 MCP 连接。发布 Release 不代表用户机器已升级。不要将凭据或本地管理面板暴露到公网。
