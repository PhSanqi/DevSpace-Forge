#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_ROOT="${DEVSPACE_CONTROL_HOME:-$HOME/.local/share/devspace-control}"
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/devspace-control"
DEVSPACE_CONFIG_DIR="$CONFIG_ROOT/devspace"
STATE_DIR="$INSTALL_ROOT/state"
WORKTREE_ROOT="$STATE_DIR/worktrees"
PORT="7677"
ALLOWED_ROOT="$HOME"
PUBLIC_URL=""
TUNNEL_TOKEN=""
START_SERVICES=1
NON_INTERACTIVE=0

usage() {
  cat <<'EOF'
Usage: ./setup-linux.sh [options]

This is an offline/full-bundle installer. Node.js, DevSpace and cloudflared are
already included in the release archive; setup does not download npm/runtime
dependencies.

Options:
  --allowed-root PATH   Project root DevSpace may access (default: $HOME)
  --port PORT           Local DevSpace port (default: 7677)
  --public-url URL      Cloudflare public origin/hostname
  --tunnel-token TOKEN  Cloudflare remotely-managed Tunnel token
  --no-start            Install and configure without starting user services
  --non-interactive     Do not prompt for missing Cloudflare values
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allowed-root) ALLOWED_ROOT="${2:?missing path}"; shift 2 ;;
    --port) PORT="${2:?missing port}"; shift 2 ;;
    --public-url) PUBLIC_URL="${2:?missing URL}"; shift 2 ;;
    --tunnel-token) TUNNEL_TOKEN="${2:?missing token}"; shift 2 ;;
    --no-start) START_SERVICES=0; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo 'setup-linux.sh only supports Linux.' >&2
  exit 1
fi
if [[ "$(uname -m)" != "x86_64" ]]; then
  echo 'This release currently supports Linux x86_64 only.' >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo 'git is required for project version management.' >&2
  exit 1
fi

BUNDLED_NODE="$ROOT/runtime/node/bin/node"
BUNDLED_DEVSPACE="$ROOT/runtime/devspace/node_modules/@waishnav/devspace"
BUNDLED_CLOUDFLARED="$ROOT/cloudflared"
if [[ ! -x "$BUNDLED_NODE" ]]; then
  echo "Bundled Node.js is missing: $BUNDLED_NODE" >&2
  exit 1
fi
if [[ ! -f "$BUNDLED_DEVSPACE/dist/cli.js" ]]; then
  echo "Bundled DevSpace runtime is missing: $BUNDLED_DEVSPACE" >&2
  exit 1
fi
if [[ ! -x "$BUNDLED_CLOUDFLARED" ]]; then
  echo "Bundled cloudflared is missing: $BUNDLED_CLOUDFLARED" >&2
  exit 1
fi

if [[ "$NON_INTERACTIVE" -eq 0 && -t 0 ]]; then
  read -r -p "Allowed project root [$ALLOWED_ROOT]: " answer
  [[ -n "$answer" ]] && ALLOWED_ROOT="$answer"
  read -r -p "Local DevSpace port [$PORT]: " answer
  [[ -n "$answer" ]] && PORT="$answer"
  if [[ -z "$PUBLIC_URL" ]]; then
    read -r -p "Cloudflare public hostname (example: devspace.example.com): " PUBLIC_URL
  fi
  if [[ -z "$TUNNEL_TOKEN" ]]; then
    read -r -s -p "Cloudflare Remote Tunnel token: " TUNNEL_TOKEN
    echo
  fi
fi

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo 'Port must be between 1 and 65535.' >&2
  exit 1
fi
if [[ ! -d "$ALLOWED_ROOT" ]]; then
  echo "Allowed root does not exist: $ALLOWED_ROOT" >&2
  exit 1
fi
ALLOWED_ROOT="$(cd "$ALLOWED_ROOT" && pwd)"

mkdir -p "$INSTALL_ROOT/runtime" "$CONFIG_ROOT" "$DEVSPACE_CONFIG_DIR" "$STATE_DIR" "$WORKTREE_ROOT" "$INSTALL_ROOT/bin"
rm -rf "$INSTALL_ROOT/runtime/node" "$INSTALL_ROOT/runtime/devspace"
cp -a "$ROOT/runtime/node" "$INSTALL_ROOT/runtime/node"
cp -a "$ROOT/runtime/devspace" "$INSTALL_ROOT/runtime/devspace"
cp -f "$BUNDLED_CLOUDFLARED" "$INSTALL_ROOT/cloudflared"
chmod 0755 "$INSTALL_ROOT/cloudflared" "$INSTALL_ROOT/runtime/node/bin/node"

NODE="$INSTALL_ROOT/runtime/node/bin/node"
DEVSPACE_PACKAGE="$INSTALL_ROOT/runtime/devspace/node_modules/@waishnav/devspace"
CLOUDFLARED="$INSTALL_ROOT/cloudflared"

PUBLIC_URL="$($NODE - "$PUBLIC_URL" <<'NODE'
const input=(process.argv[2]||'').trim();
if (!input) { console.log(''); process.exit(0); }
let value=input.includes('://') ? input : `https://${input}`;
let u;
try { u=new URL(value); } catch { console.error('Invalid Cloudflare hostname/public URL.'); process.exit(2); }
if (u.protocol !== 'https:' || !u.hostname) { console.error('Cloudflare public URL must use https.'); process.exit(2); }
const path=u.pathname.replace(/^\/+|\/+$/g,'');
if (path && path.toLowerCase() !== 'mcp') { console.error('Use only the hostname/origin, or a full /mcp URL.'); process.exit(2); }
console.log(`https://${u.hostname}`);
NODE
)"

if [[ -z "$PUBLIC_URL" && "$NON_INTERACTIVE" -eq 0 ]]; then
  echo 'Cloudflare public hostname is required for the finished Remote Tunnel setup.' >&2
  exit 1
fi

"$NODE" - "$DEVSPACE_CONFIG_DIR/config.jsonc" "$ALLOWED_ROOT" "$PUBLIC_URL" "$PORT" "$STATE_DIR" "$WORKTREE_ROOT" "$CONFIG_ROOT/agent-home" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const allowedRoot = process.argv[3];
const publicBaseUrl = process.argv[4] || null;
const port = Number(process.argv[5]);
const stateDir = process.argv[6];
const worktreeRoot = process.argv[7];
const agentDir = process.argv[8];
const allowedHosts = ['localhost', '127.0.0.1', '::1'];
if (publicBaseUrl) allowedHosts.push(new URL(publicBaseUrl).hostname);
const config = {
  configVersion: 1,
  server: { host: '127.0.0.1', port, publicBaseUrl, allowedHosts, trustProxy: Boolean(publicBaseUrl) },
  workspaces: { allowedRoots: [allowedRoot], worktreeRoot },
  storage: { stateDir },
  tools: { mode: 'codex' },
  ui: { enabled: true },
  artifacts: { enabled: false, maxFileBytes: 104857600 },
  skills: { enabled: true, paths: [], agentDir },
  subagents: { enabled: false, instructions: 'on-demand', providers: [] },
  logging: { level: 'info', format: 'json', requests: true, assets: false, toolCalls: true, shellCommands: false },
  oauth: { accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 2592000, scopes: ['devspace'], allowedResourceUrls: [], allowedRedirectHosts: ['chatgpt.com', 'localhost', '127.0.0.1'] },
};
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
NODE

if [[ ! -f "$DEVSPACE_CONFIG_DIR/auth.json" ]]; then
  OWNER_TOKEN="$("$NODE" -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
  printf '{"ownerToken":"%s"}\n' "$OWNER_TOKEN" > "$DEVSPACE_CONFIG_DIR/auth.json"
  chmod 0600 "$DEVSPACE_CONFIG_DIR/auth.json"
else
  OWNER_TOKEN="$("$NODE" -e "const a=require(process.argv[1]); console.log(a.ownerToken||'')" "$DEVSPACE_CONFIG_DIR/auth.json")"
fi

CLOUDFLARE_ENV="$CONFIG_ROOT/cloudflare.env"
if [[ -n "$TUNNEL_TOKEN" ]]; then
  printf 'CLOUDFLARED_TOKEN=%q\n' "$TUNNEL_TOKEN" > "$CLOUDFLARE_ENV"
  chmod 0600 "$CLOUDFLARE_ENV"
elif [[ ! -f "$CLOUDFLARE_ENV" && "$NON_INTERACTIVE" -eq 0 ]]; then
  echo 'Cloudflare Tunnel token is required.' >&2
  exit 1
fi

cat > "$INSTALL_ROOT/bin/run-devspace" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export DEVSPACE_CONFIG_DIR="$DEVSPACE_CONFIG_DIR"
exec "$NODE" "$DEVSPACE_PACKAGE/dist/cli.js" serve
EOF
chmod 0755 "$INSTALL_ROOT/bin/run-devspace"

cat > "$INSTALL_ROOT/bin/run-cloudflared" <<EOF
#!/usr/bin/env bash
set -euo pipefail
source "$CLOUDFLARE_ENV"
exec "$CLOUDFLARED" tunnel --protocol http2 --no-autoupdate run --token "\$CLOUDFLARED_TOKEN"
EOF
chmod 0755 "$INSTALL_ROOT/bin/run-cloudflared"

SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$SYSTEMD_DIR"
cat > "$SYSTEMD_DIR/devspace-control.service" <<EOF
[Unit]
Description=DevSpace Control - DevSpace MCP server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_ROOT/bin/run-devspace
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

cat > "$SYSTEMD_DIR/devspace-control-cloudflared.service" <<EOF
[Unit]
Description=DevSpace Control - Cloudflare Tunnel
After=network-online.target devspace-control.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_ROOT/bin/run-cloudflared
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload
  if [[ "$START_SERVICES" -eq 1 ]]; then
    systemctl --user enable --now devspace-control.service
    if [[ -f "$CLOUDFLARE_ENV" ]]; then
      systemctl --user enable --now devspace-control-cloudflared.service
    fi
  fi
else
  echo 'systemctl was not found; services were installed but not started.' >&2
fi

echo
echo "DevSpace installed under: $INSTALL_ROOT"
echo "Owner password:           $OWNER_TOKEN"
echo "Cloudflare local Origin:  http://127.0.0.1:${PORT}"
echo "Local MCP endpoint:       http://127.0.0.1:${PORT}/mcp"
if [[ -n "$PUBLIC_URL" ]]; then
  echo "Public MCP endpoint:      ${PUBLIC_URL%/}/mcp"
else
  echo 'Public MCP endpoint:      not configured'
fi
echo
echo 'Cloudflare Dashboard: route your remotely-managed Tunnel public hostname to the local Origin shown above.'
