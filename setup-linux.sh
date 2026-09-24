#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="7677"
CONSOLE_PORT=""
OWNER_COPY=1
ALLOWED_ROOT="$HOME"
PUBLIC_URL=""
ORIGIN_HOST=""
TUNNEL_TOKEN=""
INSTANCE=""
REUSE_EXISTING_TUNNEL=0
START_SERVICES=1
NON_INTERACTIVE=0
CONFIG_OVERRIDE=0
FORCE_RECONFIGURE=0
UPGRADE_EXISTING=0

usage() {
  cat <<'EOF'
Usage: ./setup-linux.sh [options]

This is an offline/full-bundle installer. Node.js, DevSpace and cloudflared are
already included in the release archive; setup does not download npm/runtime
dependencies.

Options:
  --instance NAME       Install a side-by-side named instance (for example: server)
  --allowed-root PATH   Project root DevSpace may access (default: $HOME)
  --port PORT           Local DevSpace port (default: 7677)
  --console-port PORT   Loopback-only Control Console (default: DevSpace port + 1)
  --enable-owner-copy   Allow confirmed Owner Password copy (default: enabled on localhost)
  --disable-owner-copy  Disable Owner Password copy even on localhost
  --public-url URL      Public base URL; path bases are supported (example: https://dev.example.com/server)
  --origin-host HOST    Cloudflare Tunnel origin hostname accepted by DevSpace
  --tunnel-token TOKEN  Cloudflare remotely-managed Tunnel token
  --reuse-existing-tunnel
                        Start only DevSpace; reuse an already-running Tunnel on this machine
  --reconfigure         Ignore an existing local configuration and configure again
  --no-start            Install and configure without starting user services
  --non-interactive     Do not prompt for missing Cloudflare values
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) INSTANCE="${2:?missing instance name}"; shift 2 ;;
    --allowed-root) ALLOWED_ROOT="${2:?missing path}"; CONFIG_OVERRIDE=1; shift 2 ;;
    --port) PORT="${2:?missing port}"; CONFIG_OVERRIDE=1; shift 2 ;;
    --console-port) CONSOLE_PORT="${2:?missing console port}"; shift 2 ;;
    --enable-owner-copy) OWNER_COPY=1; shift ;;
    --disable-owner-copy) OWNER_COPY=0; shift ;;
    --public-url) PUBLIC_URL="${2:?missing URL}"; CONFIG_OVERRIDE=1; shift 2 ;;
    --origin-host) ORIGIN_HOST="${2:?missing hostname}"; CONFIG_OVERRIDE=1; shift 2 ;;
    --tunnel-token) TUNNEL_TOKEN="${2:?missing token}"; CONFIG_OVERRIDE=1; shift 2 ;;
    --reuse-existing-tunnel) REUSE_EXISTING_TUNNEL=1; CONFIG_OVERRIDE=1; shift ;;
    --reconfigure) FORCE_RECONFIGURE=1; shift ;;
    --no-start) START_SERVICES=0; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -n "$INSTANCE" ]] && ! [[ "$INSTANCE" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo 'Instance name must contain only lowercase letters, digits, and hyphens.' >&2
  exit 1
fi

INSTANCE_SUFFIX=""
[[ -n "$INSTANCE" ]] && INSTANCE_SUFFIX="-$INSTANCE"
INSTALL_ROOT="${DEVSPACE_CONTROL_HOME:-$HOME/.local/share/devspace-control${INSTANCE_SUFFIX}}"
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/devspace-control${INSTANCE_SUFFIX}"
DEVSPACE_CONFIG_DIR="$CONFIG_ROOT/devspace"
STATE_DIR="$INSTALL_ROOT/state"
WORKTREE_ROOT="$STATE_DIR/worktrees"
SERVICE_BASE="devspace-control${INSTANCE_SUFFIX}"
DEVSPACE_SERVICE="$SERVICE_BASE.service"
CLOUDFLARED_SERVICE="$SERVICE_BASE-cloudflared.service"
CLOUDFLARED_WATCHDOG_SERVICE="$SERVICE_BASE-cloudflared-watchdog.service"
CLOUDFLARED_WATCHDOG_TIMER="$SERVICE_BASE-cloudflared-watchdog.timer"

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

EXISTING_CONFIG="$DEVSPACE_CONFIG_DIR/config.jsonc"
CLOUDFLARE_ENV="$CONFIG_ROOT/cloudflare.env"
if [[ -f "$EXISTING_CONFIG" && "$CONFIG_OVERRIDE" -eq 0 && "$FORCE_RECONFIGURE" -eq 0 ]]; then
  JSONC_PARSER="$ROOT/runtime/devspace/node_modules/jsonc-parser"
  mapfile -t existing_values < <("$BUNDLED_NODE" - "$EXISTING_CONFIG" "$JSONC_PARSER" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const parserRoot = process.argv[3];
const text = fs.readFileSync(file, 'utf8');
let config;
try {
  config = JSON.parse(text);
} catch (error) {
  try {
    const { parse } = require(parserRoot);
    const errors = [];
    config = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length) throw new Error(`JSONC parse errors: ${errors.map(e => e.error).join(',')}`);
  } catch (jsoncError) {
    console.error(`Existing DevSpace config cannot be read safely: ${jsoncError.message}`);
    process.exit(2);
  }
}
const port = Number(config?.server?.port || 7677);
const publicBaseUrl = String(config?.server?.publicBaseUrl || '');
const roots = Array.isArray(config?.workspaces?.allowedRoots) ? config.workspaces.allowedRoots : [];
const allowedRoot = String(roots[0] || process.env.HOME || '');
const hosts = Array.isArray(config?.server?.allowedHosts) ? config.server.allowedHosts.map(String) : [];
let publicHost = '';
try { if (publicBaseUrl) publicHost = new URL(publicBaseUrl).hostname; } catch {}
const local = new Set(['localhost', '127.0.0.1', '::1', publicHost].filter(Boolean));
const originHost = hosts.find(host => !local.has(host)) || publicHost || '';
console.log(port);
console.log(publicBaseUrl);
console.log(allowedRoot);
console.log(originHost);
NODE
  )
  if [[ "${#existing_values[@]}" -ne 4 ]]; then
    echo 'Existing DevSpace configuration did not provide the expected update metadata.' >&2
    exit 1
  fi
  PORT="${existing_values[0]}"
  PUBLIC_URL="${existing_values[1]}"
  ALLOWED_ROOT="${existing_values[2]}"
  ORIGIN_HOST="${existing_values[3]}"
  UPGRADE_EXISTING=1
  NON_INTERACTIVE=1
  if [[ ! -f "$CLOUDFLARE_ENV" ]]; then REUSE_EXISTING_TUNNEL=1; fi
  echo "Existing DevSpace configuration detected; updating runtime in place without reconfiguration."
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
CONSOLE_PORT="${CONSOLE_PORT:-$((PORT + 1))}"
if ! [[ "$CONSOLE_PORT" =~ ^[0-9]+$ ]] || (( CONSOLE_PORT < 1 || CONSOLE_PORT > 65535 || CONSOLE_PORT == PORT )); then
  echo 'Invalid console port.' >&2
  exit 1
fi
if [[ "$UPGRADE_EXISTING" -eq 0 && ! -d "$ALLOWED_ROOT" ]]; then
  echo "Allowed root does not exist: $ALLOWED_ROOT" >&2
  exit 1
fi
if [[ "$UPGRADE_EXISTING" -eq 0 ]]; then ALLOWED_ROOT="$(cd "$ALLOWED_ROOT" && pwd)"; fi

mkdir -p "$INSTALL_ROOT/runtime" "$CONFIG_ROOT" "$DEVSPACE_CONFIG_DIR" "$STATE_DIR" "$WORKTREE_ROOT" "$INSTALL_ROOT/bin"
install -m 0755 "$ROOT/ops/runtime-console.sh" "$INSTALL_ROOT/bin/runtime-console"
install -m 0755 "$ROOT/ops/runtime-console.mjs" "$INSTALL_ROOT/bin/runtime-console.mjs"
install -m 0644 "$ROOT/ops/runtime-rollback.mjs" "$INSTALL_ROOT/bin/runtime-rollback.mjs"
install -m 0644 "$ROOT/ops/runtime-console-ui.html" "$INSTALL_ROOT/bin/runtime-console-ui.html"
install -m 0644 "$ROOT/ops/runtime-console-ui.css" "$INSTALL_ROOT/bin/runtime-console-ui.css"
install -m 0644 "$ROOT/ops/runtime-console-ui.js" "$INSTALL_ROOT/bin/runtime-console-ui.js"
if [[ -f "$ROOT/control-provenance.json" ]]; then
  install -m 0644 "$ROOT/control-provenance.json" "$INSTALL_ROOT/control-provenance.json"
fi
cat > "$INSTALL_ROOT/runtime-console.env" <<EOF
DEVSPACE_SERVICE=$DEVSPACE_SERVICE
TUNNEL_SERVICE=$CLOUDFLARED_SERVICE
EOF
chmod 0644 "$INSTALL_ROOT/runtime-console.env"
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
if (u.search || u.hash) { console.error('Cloudflare public URL must not contain query or fragment components.'); process.exit(2); }
let path=u.pathname.replace(/\/+$/g,'');
if (path.toLowerCase().endsWith('/mcp')) path=path.slice(0,-4).replace(/\/+$/g,'');
if (path === '/') path='';
console.log(`https://${u.hostname}${path}`);
NODE
)"

MCP_PATH="$($NODE - "$PUBLIC_URL" <<'NODE'
const input=(process.argv[2]||'').trim();
if (!input) { console.log('/mcp'); process.exit(0); }
const u=new URL(input);
const base=u.pathname.replace(/\/+$/g,'');
console.log(`${base || ''}/mcp`);
NODE
)"

if [[ -z "$PUBLIC_URL" && "$NON_INTERACTIVE" -eq 0 ]]; then
  echo 'Cloudflare public hostname is required for the finished Remote Tunnel setup.' >&2
  exit 1
fi

if [[ "$UPGRADE_EXISTING" -eq 0 ]]; then
"$NODE" - "$DEVSPACE_CONFIG_DIR/config.jsonc" "$ALLOWED_ROOT" "$PUBLIC_URL" "$PORT" "$STATE_DIR" "$WORKTREE_ROOT" "$CONFIG_ROOT/agent-home" "$ORIGIN_HOST" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const allowedRoot = process.argv[3];
const publicBaseUrl = process.argv[4] || null;
const port = Number(process.argv[5]);
const stateDir = process.argv[6];
const worktreeRoot = process.argv[7];
const agentDir = process.argv[8];
const originHost = process.argv[9] || '';
const allowedHosts = ['localhost', '127.0.0.1', '::1'];
if (publicBaseUrl) allowedHosts.push(new URL(publicBaseUrl).hostname);
if (originHost && !allowedHosts.includes(originHost)) allowedHosts.push(originHost);
const config = {
  configVersion: 1,
  server: { host: '127.0.0.1', port, publicBaseUrl, allowedHosts, trustProxy: false },
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
fi

if [[ ! -f "$DEVSPACE_CONFIG_DIR/auth.json" ]]; then
  OWNER_TOKEN="$("$NODE" -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
  printf '{"ownerToken":"%s"}\n' "$OWNER_TOKEN" > "$DEVSPACE_CONFIG_DIR/auth.json"
  chmod 0600 "$DEVSPACE_CONFIG_DIR/auth.json"
else
  OWNER_TOKEN="$("$NODE" -e "const a=require(process.argv[1]); console.log(a.ownerToken||'')" "$DEVSPACE_CONFIG_DIR/auth.json")"
fi

if [[ "$UPGRADE_EXISTING" -eq 1 ]]; then
  :
elif [[ "$REUSE_EXISTING_TUNNEL" -eq 1 ]]; then
  :
elif [[ -n "$TUNNEL_TOKEN" ]]; then
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
cat > "$INSTALL_ROOT/bin/run-runtime-console" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$NODE" "$INSTALL_ROOT/bin/runtime-console.mjs" --instance "${INSTANCE:-default}" --platform-root "$INSTALL_ROOT" --config "$DEVSPACE_CONFIG_DIR/config.jsonc" --credential-file "$DEVSPACE_CONFIG_DIR/auth.json" --allow-owner-copy "$([[ "$OWNER_COPY" == 1 ]] && echo true || echo false)" --service-unit "$DEVSPACE_SERVICE" --tunnel-unit "$CLOUDFLARED_SERVICE" --state-dir "$STATE_DIR/devspace-state" --serve "$CONSOLE_PORT"
EOF
chmod 0755 "$INSTALL_ROOT/bin/run-runtime-console"

CLOUDFLARED_PROTOCOL="${DEVSPACE_CLOUDFLARED_PROTOCOL:-auto}"
if [[ "$UPGRADE_EXISTING" -eq 1 ]]; then CLOUDFLARED_PROTOCOL="auto"; fi
case "$CLOUDFLARED_PROTOCOL" in auto|quic|http2) ;; *) echo 'DEVSPACE_CLOUDFLARED_PROTOCOL must be auto, quic, or http2.' >&2; exit 1 ;; esac
CLOUDFLARED_PROTOCOL_ARG=""
[[ "$CLOUDFLARED_PROTOCOL" == "auto" ]] || CLOUDFLARED_PROTOCOL_ARG="--protocol $CLOUDFLARED_PROTOCOL"

cat > "$INSTALL_ROOT/bin/run-cloudflared" <<EOF
#!/usr/bin/env bash
set -euo pipefail
source "$CLOUDFLARE_ENV"
exec "$CLOUDFLARED" tunnel $CLOUDFLARED_PROTOCOL_ARG --no-autoupdate run --token "\$CLOUDFLARED_TOKEN"
EOF
chmod 0755 "$INSTALL_ROOT/bin/run-cloudflared"

SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$SYSTEMD_DIR"
cat > "$SYSTEMD_DIR/$DEVSPACE_SERVICE" <<EOF
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

CONSOLE_SERVICE="${SERVICE_BASE}-console.service"
cat > "$SYSTEMD_DIR/$CONSOLE_SERVICE" <<EOF
[Unit]
Description=DevSpace Control - Runtime Console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_ROOT/bin/run-runtime-console
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
UMask=0077

[Install]
WantedBy=default.target
EOF

if [[ "$REUSE_EXISTING_TUNNEL" -eq 0 ]]; then
cat > "$SYSTEMD_DIR/$CLOUDFLARED_SERVICE" <<EOF
[Unit]
Description=DevSpace Control - Cloudflare Tunnel
After=network-online.target $DEVSPACE_SERVICE
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_ROOT/bin/run-cloudflared
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF


BASE_PATH="${MCP_PATH%/mcp}"
HEALTH_PATH="${BASE_PATH}/healthz"
WATCHDOG_TARGET=""
if [[ -n "$ORIGIN_HOST" ]]; then
  WATCHDOG_TARGET="https://${ORIGIN_HOST}${HEALTH_PATH}"
elif [[ -n "$PUBLIC_URL" ]]; then
  WATCHDOG_TARGET="${PUBLIC_URL%/}/healthz"
fi
if [[ -n "$WATCHDOG_TARGET" ]]; then
  WATCHDOG_STATE="$STATE_DIR/cloudflared-watchdog-failures"
  cat > "$INSTALL_ROOT/bin/check-cloudflared" <<EOF
#!/usr/bin/env bash
set -euo pipefail
LOCAL_URL="http://127.0.0.1:${PORT}${HEALTH_PATH}"
ORIGIN_URL="$WATCHDOG_TARGET"
STATE_FILE="$WATCHDOG_STATE"
TUNNEL_SERVICE="$CLOUDFLARED_SERVICE"

probe_200() {
  local url="\$1"
  local code
  code="\$(curl -sS -o /dev/null --max-time 8 --connect-timeout 3 --max-redirs 0 -w '%{http_code}' "\$url" 2>/dev/null || true)"
  [[ "\$code" == "200" ]]
}

if ! probe_200 "\$LOCAL_URL"; then
  printf '0\n' > "\$STATE_FILE"
  echo "watchdog: local DevSpace is not healthy; tunnel restart suppressed"
  exit 0
fi

if probe_200 "\$ORIGIN_URL"; then
  printf '0\n' > "\$STATE_FILE"
  exit 0
fi

failures=0
if [[ -f "\$STATE_FILE" ]]; then read -r failures < "\$STATE_FILE" || failures=0; fi
[[ "\$failures" =~ ^[0-9]+$ ]] || failures=0
failures=\$((failures + 1))
printf '%s\n' "\$failures" > "\$STATE_FILE"
echo "watchdog: origin health failed (\$failures/3): \$ORIGIN_URL"
if (( failures >= 3 )); then
  printf '0\n' > "\$STATE_FILE"
  echo "watchdog: restarting \$TUNNEL_SERVICE after 3 consecutive origin failures"
  systemctl --user restart "\$TUNNEL_SERVICE"
fi
EOF
  chmod 0755 "$INSTALL_ROOT/bin/check-cloudflared"

  cat > "$SYSTEMD_DIR/$CLOUDFLARED_WATCHDOG_SERVICE" <<EOF
[Unit]
Description=DevSpace Control - Cloudflare Tunnel health watchdog
After=network-online.target $DEVSPACE_SERVICE $CLOUDFLARED_SERVICE
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$INSTALL_ROOT/bin/check-cloudflared
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
UMask=0077
EOF

  cat > "$SYSTEMD_DIR/$CLOUDFLARED_WATCHDOG_TIMER" <<EOF
[Unit]
Description=DevSpace Control - Cloudflare Tunnel health watchdog timer

[Timer]
OnBootSec=90s
OnUnitActiveSec=60s
Unit=$CLOUDFLARED_WATCHDOG_SERVICE
Persistent=true

[Install]
WantedBy=timers.target
EOF
fi
fi

probe_endpoint() {
  local url="$1"
  local code=""
  if command -v curl >/dev/null 2>&1; then
    code="$(curl -sS -o /dev/null --max-time 4 --connect-timeout 2 --max-redirs 0 -w '%{http_code}' "$url" 2>/dev/null || true)"
  else
    code="$($NODE - "$url" <<'NODE'
const http = require('node:http');
const https = require('node:https');
const url = new URL(process.argv[2]);
const client = url.protocol === 'https:' ? https : http;
const request = client.request(url, { method: 'GET', timeout: 3500 }, response => {
  console.log(response.statusCode || 0);
  response.resume();
});
request.on('timeout', () => request.destroy());
request.on('error', () => console.log(0));
request.end();
NODE
)"
  fi
  [[ "$code" =~ ^[0-9]+$ ]] || return 1
  (( code >= 200 && code < 500 && code != 404 ))
}

wait_for_endpoint() {
  local url="$1"
  local timeout="$2"
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    if probe_endpoint "$url"; then return 0; fi
    sleep 1
  done
  return 1
}

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload
  if [[ "$START_SERVICES" -eq 1 ]]; then
    systemctl --user enable --now "$DEVSPACE_SERVICE"
    systemctl --user enable --now "$CONSOLE_SERVICE"
    if [[ "$REUSE_EXISTING_TUNNEL" -eq 0 && -f "$CLOUDFLARE_ENV" ]]; then
      systemctl --user enable --now "$CLOUDFLARED_SERVICE"
      if [[ -f "$SYSTEMD_DIR/$CLOUDFLARED_WATCHDOG_TIMER" ]]; then
        systemctl --user enable --now "$CLOUDFLARED_WATCHDOG_TIMER"
      fi
    fi

    echo 'Verifying DevSpace and Cloudflare connectivity...'
    if ! systemctl --user is-active --quiet "$DEVSPACE_SERVICE"; then
      echo 'DevSpace user service did not stay active.' >&2
      systemctl --user --no-pager status "$DEVSPACE_SERVICE" >&2 || true
      exit 1
    fi
    if ! wait_for_endpoint "http://127.0.0.1:${PORT}${MCP_PATH}" 45; then
      echo "Local DevSpace MCP did not become reachable: http://127.0.0.1:${PORT}${MCP_PATH}" >&2
      systemctl --user --no-pager status "$DEVSPACE_SERVICE" >&2 || true
      exit 1
    fi
    if ! wait_for_endpoint "http://127.0.0.1:${CONSOLE_PORT}/api/status" 20; then
      echo 'Runtime Console did not become reachable.' >&2
      systemctl --user --no-pager status "$CONSOLE_SERVICE" >&2 || true
      exit 1
    fi
    if [[ "$REUSE_EXISTING_TUNNEL" -eq 0 && -f "$CLOUDFLARE_ENV" ]]; then
      if ! systemctl --user is-active --quiet "$CLOUDFLARED_SERVICE"; then
        echo 'Cloudflare Tunnel user service did not stay active.' >&2
        systemctl --user --no-pager status "$CLOUDFLARED_SERVICE" >&2 || true
        exit 1
      fi
      if [[ -n "$PUBLIC_URL" ]] && ! wait_for_endpoint "${PUBLIC_URL%/}/mcp" 60; then
        echo "Public MCP did not become reachable: ${PUBLIC_URL%/}/mcp" >&2
        echo 'Confirm the Cloudflare Public Hostname routes to the local Origin shown below.' >&2
        systemctl --user --no-pager status "$CLOUDFLARED_SERVICE" >&2 || true
        exit 1
      fi
    elif [[ "$REUSE_EXISTING_TUNNEL" -eq 1 ]]; then
      echo 'Reusing an existing Cloudflare Tunnel; public-route verification is deferred until its Published Application is added.'
    fi
    echo 'Connectivity verification passed.'
  fi
else
  echo 'systemctl was not found; services were installed but not started.' >&2
fi

echo
echo "DevSpace installed under: $INSTALL_ROOT"
echo "Owner password:           $OWNER_TOKEN"
echo "Cloudflare local Origin:  http://127.0.0.1:${PORT}"
echo "Local MCP endpoint:       http://127.0.0.1:${PORT}${MCP_PATH}"
echo "Local Control Console:    http://127.0.0.1:${CONSOLE_PORT}/"
if [[ -n "$PUBLIC_URL" ]]; then
  echo "Public MCP endpoint:      ${PUBLIC_URL%/}/mcp"
else
  echo 'Public MCP endpoint:      not configured'
fi
echo
if [[ "$REUSE_EXISTING_TUNNEL" -eq 1 ]]; then
  echo "Cloudflare Dashboard: add a Published Application on the existing Tunnel: ${ORIGIN_HOST:-<origin-host>} -> http://127.0.0.1:${PORT}"
else
  echo 'Cloudflare Dashboard: route your remotely-managed Tunnel public hostname to the local Origin shown above.'
fi
