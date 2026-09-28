# Supported platforms / 支持的平台

DevSpace-Forge distributes independent Windows x64 and Linux x64 offline packages. Both include a pinned DevSpace Runtime, Node.js and cloudflared.

| Platform | Package | Setup and management |
| --- | --- | --- |
| Windows x64 | ZIP archive with checksum | Setup.exe and desktop manager |
| Linux x64 | tar.gz archive with checksum | setup-linux.sh and loopback-only web Console |

Control and Runtime have independent version numbers. Read the package's provenance manifest and the matching Release notes rather than assuming that a newly published version is already installed.

The Windows manager and Linux Console are local control surfaces. Your public Tunnel hostname should expose the selected MCP/OAuth endpoint, never the management interface.

Release assets and their verification files are available from this repository's Releases page. See [installation](docs/getting-started.md) and [safe upgrades](docs/releases-and-upgrades.md).

中文：Windows 与 Linux 分别提供完整离线包与校验文件，内置同一固定 Runtime。Control 与 Runtime 独立编号；GitHub 发布不等于自动更新已安装电脑。管理界面只在本机使用，公网只开放用户配置的 MCP/OAuth 入口。
