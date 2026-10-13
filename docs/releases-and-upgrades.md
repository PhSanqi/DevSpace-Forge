# Releases and safe upgrades / 发行与安全升级

## Current release: v0.6.13 / 当前版本：v0.6.13

v0.6.13 publishes the modern Desktop/Control ownership changes with a corrected Linux release path. Linux packaging now installs the Control UI dependencies before building, so the package can be produced on a clean runner. Existing installations should use the normal Setup update path rather than manually replacing Runtime files.

v0.6.13 正式发布 Modern Desktop / Control ownership 改动，并修复 Linux Release 在干净 runner 上缺少 Control UI 依赖的问题。已有安装应使用正常的 Setup 更新流程，不要手工替换 Runtime 文件。

For the complete change list and post-upgrade checks, see [v0.6.13 release notes](release-notes-v0.6.13.md).

## Choose and verify a package

Open this repository's Releases tab. Download the Windows x64 ZIP or Linux x64 tar.gz, together with the corresponding SHA-256 sidecar. Before extracting, compare the downloaded archive's SHA-256 to the supplied file.

DevSpace-Forge has one public release line. Its embedded Runtime is built from the `runtime-src/` source directory in the same Git revision and retains an internal package version only for provenance and compatibility checks. Each package includes provenance manifests for both the product and embedded Runtime. A GitHub Release does not update an already running installation.

## Install or update

**Windows:** extract the archive and run Setup.exe. If it detects an existing installation, use its update flow. Confirm the target installation before proceeding. v0.6.13 upgrades legacy Windows launcher ownership to the modern Desktop launcher and preserves the configured instance route.

**Linux:** extract the archive and run ./setup-linux.sh. An existing configuration can be updated in place; use the explicit reconfiguration option only when you intend to change connection settings. Actual systemd unit names depend on your instance name.

Before updating, confirm that your projects and settings are backed up and no active task will be interrupted. Keep the previous working version until the new one passes health, MCP/OAuth and project-access checks. If the update fails, restore the prior installation using the provided rollback path.

Never publish the management Console, Owner password, Tunnel credential, local job store or environment files. Do not paste a real token into a support issue or shell command that will be recorded.

## What you may safely delete

You can remove downloaded archive duplicates and temporary build directories that you have verified are not used. Keep your configured Runtime, state database, workspace files, credentials, and the most recent working rollback until a successful upgrade is confirmed.

The public Git repository and historical release assets are source and distribution records, not your machine's installation inventory. Deleting an old tag does not uninstall an old runtime.

For optional public website hosting see [website setup](public-website.md). For everyday service management see [Console guide](runtime-console.md).

中文摘要：按系统选择离线包并核对 SHA-256；先备份，再检查活动任务，升级后验证本地进程与 MCP 连接。发布 Release 不代表用户机器已升级。不要将凭据或本地管理面板暴露到公网。
