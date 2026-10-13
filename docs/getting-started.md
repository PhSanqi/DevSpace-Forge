# Installation and MCP connection / 安装与连接

DevSpace-Forge runs the development tools on **your own** Windows or Linux machine. The public hostname, if you enable one, belongs to you. The examples below use reserved example.com addresses rather than a live service.

## Step 1: Install

Download the latest platform archive and matching SHA-256 sidecar from this repository's Releases tab. Verify the checksum. On Windows, extract and run `Setup.exe`. On Linux, extract and run `./setup-linux.sh`.

The Windows installer is a guided wizard. It intentionally avoids asking new users to understand internal terms such as Origin or Endpoint before they can install the product. The Linux package currently supports Linux x86_64 and the install script rejects an incompatible platform before changing the installation.

## Step 2: Prepare a domain

You need a domain that you control; it does not have to be a “free domain”. Add that domain to your own Cloudflare account and finish the DNS setup until Cloudflare reports the zone as **Active**. The Windows wizard keeps this as a checklist and does not proceed until you confirm both prerequisites.

## Step 3: Create the Tunnel

In the Cloudflare dashboard, go to **Networking → Tunnels** and create a Tunnel. A simple descriptive name is enough.

Cloudflare then shows **Setup Environment**. The Windows wizard displays the detected machine as Windows x64 or x86; current Windows release packages are x64. Select the matching environment in Cloudflare and copy the complete **Install and Run** command.

Paste the whole command into Setup. Do not manually extract the token and do not run the service-install command in a terminal. DevSpace-Forge already contains its pinned `cloudflared` binary. Setup extracts the remotely-managed Tunnel credential, stores it only through protected local handling, and starts the bundled connector temporarily so the Cloudflare page can reach **Healthy / Connected**.

This avoids two competing tunnel owners: the final DevSpace Control process, rather than a second independently installed Windows service, remains responsible for starting and supervising the bundled connector after installation.

## Step 4: Publish DevSpace

Once the Tunnel is Healthy, open that Tunnel's **Routes**, choose **Add route → Published application**, then choose a subdomain and your Cloudflare-managed domain.

Setup shows the exact **Service URL** for the local DevSpace service, for example:

    http://127.0.0.1:7677

Copy that value into Cloudflare's Service URL field and save the route. Record the resulting public hostname in Setup, such as `workspace.example.com`. For a normal single-machine installation, there is no additional public-endpoint field to understand. The optional multi-machine gateway address is kept under Advanced settings.

Publishing a Tunnel route and creating a Cloudflare Access application are separate operations. Access is optional; add it later if you want Cloudflare login/policy enforcement in front of the published hostname.

## Step 5: Approve local folders

Choose an Allowed Root containing projects you intend the assistant to access. Prefer a dedicated project directory rather than your entire home directory. Setup then shows a summary before it writes the final configuration.

The Tunnel credential is stored in a current-user protected local secrets file. Keep the original Cloudflare command, token, Owner password and other credentials out of screenshots, Git, issues and project files.

## Step 6: Connect your AI client

In an MCP-capable client, configure the full HTTPS MCP address shown by Setup. For an ordinary hostname, it has this form:

    https://workspace.example.com/mcp

Complete initial Owner approval, then ask the assistant to open a project within the approved root, inspect Git status, make a small change, run tests and show the diff.

If it cannot connect, check local health, the Tunnel connector, the published hostname, DNS proxy status and OAuth discovery in that order. The privileged Console must never be the public MCP target.

## Keeping your installation safe

Review requested file and shell actions. Use project-level Git commits and Review checkpoints. Preserve settings and working Runtime backups when updating; do not force-stop active long jobs. See [releases and upgrades](releases-and-upgrades.md).

中文要点：下载并校验离线包；Windows Setup 会按“域名 → Cloudflare → Tunnel → 粘贴完整安装命令 → Tunnel Healthy → Published application → 项目目录 → 安装”逐步引导。无需自己截取 Tunnel token，也无需先在终端安装第二套 cloudflared 服务。真实 Token、密码和项目日志不应进入公开仓库或截图。
