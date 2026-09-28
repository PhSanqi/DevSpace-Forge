# Installation and MCP connection / 安装与连接

DevSpace-Forge runs the development tools on **your own** Windows or Linux machine. The public hostname, if you enable one, belongs to you. The examples below use reserved example.com addresses rather than a live service.

## Step 1: Install

Download the latest platform archive and matching SHA-256 sidecar from this repository's Releases tab. Verify the checksum. On Windows, extract and run Setup.exe. On Linux, extract and run ./setup-linux.sh.

## Step 2: Approve local folders

Choose an Allowed Root containing projects you intend the assistant to access. Prefer a dedicated project directory rather than your entire home directory. The setup flow shows a local Origin and MCP endpoint. Confirm that the local health check succeeds.

## Step 3: Optional remote access

In your own Cloudflare account, create a remotely managed Tunnel and public hostname. Point the hostname at the local Origin displayed by the installer. Use a hostname such as workspace.example.com in your own domain; this example does not resolve to a project-owned service.

Enter the Tunnel credential through the installer's supported protected input, and keep it out of screenshots, Git, shell history and project settings. Ordinary single-instance installation does not require an API token or a custom Worker.

## Step 4: Connect your AI client

In an MCP-capable client, configure the full HTTPS MCP address shown by Setup. For an ordinary hostname, it has this form:

    https://workspace.example.com/mcp

Complete initial Owner approval, then ask the assistant to open a project within the approved root, inspect Git status, make a small change, run tests and show the diff.

If it cannot connect, check local health, the Tunnel connector, the published hostname, DNS proxy status and OAuth discovery in that order. The privileged Console must never be the public MCP target.

## Keeping your installation safe

Review requested file and shell actions. Use project-level Git commits and Review checkpoints. Preserve settings and working Runtime backups when updating; do not force-stop active long jobs. See [releases and upgrades](releases-and-upgrades.md).

中文要点：下载并校验离线包，安装后只授权所需项目目录；如需远程访问，请在自己的 Cloudflare 账户建立 Tunnel，把域名指向安装器显示的本地 Origin；然后在支持 MCP 的客户端完成授权。真实 Token、密码和项目日志不应进入公开仓库或截图。
