# Self-hosting the optional product website / 自托管产品主页

This optional website is a static introduction and installation guide for your users. It is separate from the DevSpace Runtime and the privileged local Console. You can serve it on a Linux host you control and publish it through your own Cloudflare Tunnel. You do not need the website to use a normal MCP installation.

## Prepare your site

Set an HTTPS hostname in your own domain and a link to your public GitHub repository. Example values below are **placeholders**:

    export DEVSPACE_SITE_PUBLIC_URL=https://site.example.com
    export DEVSPACE_SITE_REPO_URL=https://github.com/example/devspace-forge
    bash ops/deploy-public-site-linux.sh

The script validates both URLs, renders the public HTML, metadata, robots and sitemap from reusable templates, and stores your settings in a local mode-0600 configuration file outside this Git repository. Later updates reuse that private file; your hostname and account are not committed. The service listens only on a loopback address. To review locally:

    systemctl --user status devspace-forge-public-site.service
    curl -I http://127.0.0.1:17679/
    curl -I http://127.0.0.1:17679/docs/

Use your Tunnel provider's public-hostname configuration to direct the HTTPS hostname to that local HTTP Origin. If the hostname is also used for MCP, retain the dedicated MCP/OAuth routes and ensure normal website paths do not execute a catch-all Worker. DNS and Workers routing are cloud account changes, not part of this site's installer.

## What is public

The site serves the home page, user-facing documentation, styles, JavaScript, product icon, robots and sitemap. It provides no project browsing, private status API, token retrieval or shell interface. Unknown paths return 404. The privileged Console remains on loopback and must not be routed publicly.

## Verify before announcing your site

1. Check the home page, docs, CSS/JS and icon return 200 over HTTPS and the default is light mode.
2. Check the HTTP address upgrades to the same HTTPS hostname without dropping the path/query.
3. Verify CSP, HSTS and that unknown paths/private management URLs return 404.
4. If using multi-instance MCP, independently verify health and OAuth discovery for every instance.
5. Retain the previous website release symlink until the new site works; the deployer displays the prior release for rollback.

Do not include your actual Tunnel UUID, public/private origin names, token, local home path, account identity or deployment logs in a public README, issue or release archive.

中文：本页是提供给所有自托管用户的通用操作说明。网站域名与仓库链接在部署时传入，保存在 Git 之外的本地私有配置中；公开源码只保留模板。部署网站不应重启 DevSpace、公开本地 Console，或覆盖已有 MCP/OAuth 路由。
