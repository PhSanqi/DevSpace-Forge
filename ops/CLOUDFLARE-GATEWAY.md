# Cloudflare gateway

Canonical public MCP endpoints:

- `https://dev.sanqi.org/group/mcp`
- `https://dev.sanqi.org/server/mcp`

Each machine keeps its own Tunnel or existing Tunnel. The Worker only routes
path families to hidden Tunnel origin hostnames.

## Group

- `group-origin.sanqi.org` -> `http://127.0.0.1:17677`
- Public base: `https://dev.sanqi.org/group`
- Routes: `dev.sanqi.org/group*`, `dev.sanqi.org/.well-known/oauth-authorization-server/group*`, `dev.sanqi.org/.well-known/oauth-protected-resource/group*`

## Server

- `server-origin.sanqi.org` -> `http://127.0.0.1:17677`
- Public base: `https://dev.sanqi.org/server`
- Routes: `dev.sanqi.org/server*`, `dev.sanqi.org/.well-known/oauth-authorization-server/server*`, `dev.sanqi.org/.well-known/oauth-protected-resource/server*`

The Server migration is complete. Its DevSpace instance and Tunnel connector are
owned by separate user services:

- `devspace-control-server.service`
- `devspace-server-cloudflared.service`

The retired Python Control, port 7676 and port 8787 must not be reintroduced.
For a fresh sidecar deployment, `ops/install-linux-sidecar-instance.sh` can
adopt a remotely-managed Tunnel token with `--tunnel-token-file`.

Do not add Cloudflare Access Managed OAuth. DevSpace owns OAuth.
