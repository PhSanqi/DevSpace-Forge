#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTANCE=""
PORT="17677"
CONSOLE_PORT=""
PUBLIC_URL=""
ORIGIN_HOST=""
ALLOWED_ROOT="$HOME/codex-workspace"
RUNTIME_ROOT="$HOME/.local/share/devspace-control/runtime"
TUNNEL_TOKEN_FILE=""
TUNNEL_PROTOCOL="auto"

usage() {
  cat <<'EOF'
Usage: install-linux-sidecar-instance.sh --instance NAME --public-url URL --origin-host HOST [options]

Installs an isolated DevSpace instance. It can either reuse an externally
managed Tunnel or own a dedicated cloudflared user service.

Options:
  --instance NAME       Instance slug, for example server
  --port PORT           Local DevSpace port (default: 17677)
  --console-port PORT   Loopback-only Control Console (default: DevSpace port + 1)
  --public-url URL      Public base URL, for example https://dev.sanqi.org/server
  --origin-host HOST    Tunnel hostname, for example server-origin.sanqi.org
  --allowed-root PATH   Allowed project root
  --runtime-root PATH   Existing DevSpace runtime root
  --tunnel-token-file PATH
                        Copy an existing remotely-managed Tunnel token and run
                        a dedicated devspace-INSTANCE-cloudflared.service
  --tunnel-protocol MODE
                        cloudflared edge protocol: auto, quic, or http2
                        (default: auto)
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) INSTANCE="${2:?missing instance name}"; shift 2 ;;
    --port) PORT="${2:?missing port}"; shift 2 ;;
    --console-port) CONSOLE_PORT="${2:?missing console port}"; shift 2 ;;
    --public-url) PUBLIC_URL="${2:?missing public URL}"; shift 2 ;;
    --origin-host) ORIGIN_HOST="${2:?missing origin hostname}"; shift 2 ;;
    --allowed-root) ALLOWED_ROOT="${2:?missing allowed root}"; shift 2 ;;
    --runtime-root) RUNTIME_ROOT="${2:?missing runtime root}"; shift 2 ;;
    --tunnel-token-file) TUNNEL_TOKEN_FILE="${2:?missing token file}"; shift 2 ;;
    --tunnel-protocol) TUNNEL_PROTOCOL="${2:?missing tunnel protocol}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$INSTANCE" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo 'Invalid instance name.' >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || { echo 'Invalid port.' >&2; exit 1; }
CONSOLE_PORT="${CONSOLE_PORT:-$((PORT + 1))}"
[[ "$CONSOLE_PORT" =~ ^[0-9]+$ ]] && (( CONSOLE_PORT >= 1 && CONSOLE_PORT <= 65535 && CONSOLE_PORT != PORT )) || { echo 'Invalid console port.' >&2; exit 1; }
[[ -n "$PUBLIC_URL" ]] || { echo '--public-url is required.' >&2; exit 1; }
[[ -n "$ORIGIN_HOST" ]] || { echo '--origin-host is required.' >&2; exit 1; }
[[ -d "$ALLOWED_ROOT" ]] || { echo "Allowed root does not exist: $ALLOWED_ROOT" >&2; exit 1; }
case "$TUNNEL_PROTOCOL" in auto|quic|http2) ;; *) echo 'Tunnel protocol must be auto, quic, or http2.' >&2; exit 1 ;; esac

NODE="$(command -v node)"
SOURCE_DEVSPACE_PACKAGE="$RUNTIME_ROOT/node_modules/@waishnav/devspace"
[[ -x "$NODE" ]] || { echo 'node is required.' >&2; exit 1; }
[[ -f "$SOURCE_DEVSPACE_PACKAGE/dist/cli.js" ]] || { echo "DevSpace runtime not found: $SOURCE_DEVSPACE_PACKAGE" >&2; exit 1; }

PUBLIC_URL="$($NODE - "$PUBLIC_URL" <<'NODE'
const input=(process.argv[2]||'').trim();
let u;
try { u=new URL(input.includes('://') ? input : `https://${input}`); }
catch { console.error('Invalid public URL.'); process.exit(2); }
if (u.protocol !== 'https:' || !u.hostname || u.search || u.hash) {
  console.error('Public URL must be https and contain no query/fragment.'); process.exit(2);
}
let path=u.pathname.replace(/\/+$/g,'');
if (path.toLowerCase().endsWith('/mcp')) path=path.slice(0,-4).replace(/\/+$/g,'');
if (path === '/') path='';
console.log(`https://${u.hostname}${path}`);
NODE
)"

MCP_PATH="$($NODE - "$PUBLIC_URL" <<'NODE'
const u=new URL(process.argv[2]);
const base=u.pathname.replace(/\/+$/g,'');
console.log(`${base || ''}/mcp`);
NODE
)"

INSTALL_ROOT="$HOME/.local/share/devspace-control-$INSTANCE"
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/devspace-control-$INSTANCE"
CONFIG_DIR="$CONFIG_ROOT/devspace"
STATE_DIR="$INSTALL_ROOT/state"
WORKTREE_ROOT="$STATE_DIR/worktrees"
AGENT_DIR="$STATE_DIR/agent-home"
SERVICE="devspace-control-$INSTANCE.service"
CONSOLE_SERVICE="devspace-control-$INSTANCE-console.service"
TUNNEL_SERVICE="devspace-$INSTANCE-cloudflared.service"
TUNNEL_WATCHDOG_SERVICE="devspace-$INSTANCE-cloudflared-watchdog.service"
TUNNEL_WATCHDOG_TIMER="devspace-$INSTANCE-cloudflared-watchdog.timer"

mkdir -p "$INSTALL_ROOT/bin" "$CONFIG_DIR" "$STATE_DIR/devspace-state" "$WORKTREE_ROOT" "$AGENT_DIR"
chmod 0700 "$CONFIG_DIR" "$STATE_DIR" "$AGENT_DIR" || true
install -m 0755 "$SCRIPT_DIR/runtime-console.sh" "$INSTALL_ROOT/bin/runtime-console"
install -m 0755 "$SCRIPT_DIR/runtime-console.mjs" "$INSTALL_ROOT/bin/runtime-console.mjs"
install -m 0644 "$SCRIPT_DIR/runtime-console-ui.html" "$INSTALL_ROOT/bin/runtime-console-ui.html"
install -m 0644 "$SCRIPT_DIR/runtime-console-ui.css" "$INSTALL_ROOT/bin/runtime-console-ui.css"
install -m 0644 "$SCRIPT_DIR/runtime-console-ui.js" "$INSTALL_ROOT/bin/runtime-console-ui.js"
cat > "$INSTALL_ROOT/runtime-console.env" <<EOF
DEVSPACE_SERVICE=$SERVICE
TUNNEL_SERVICE=$TUNNEL_SERVICE
EOF
chmod 0644 "$INSTALL_ROOT/runtime-console.env"

INSTANCE_RUNTIME="$INSTALL_ROOT/runtime"
if [[ ! -f "$INSTANCE_RUNTIME/node_modules/@waishnav/devspace/dist/cli.js" ]]; then
  mkdir -p "$INSTANCE_RUNTIME"
  cp -a "$RUNTIME_ROOT/." "$INSTANCE_RUNTIME/"
fi
DEVSPACE_PACKAGE="$INSTANCE_RUNTIME/node_modules/@waishnav/devspace"
INSTANCE_CLOUDFLARED="$INSTANCE_RUNTIME/bin/cloudflared"

"$NODE" - "$CONFIG_DIR/config.jsonc" "$ALLOWED_ROOT" "$PUBLIC_URL" "$PORT" "$STATE_DIR" "$WORKTREE_ROOT" "$AGENT_DIR" "$ORIGIN_HOST" <<'NODE'
const fs=require('node:fs');
const [file, allowedRoot, publicBaseUrl, portText, stateDir, worktreeRoot, agentDir, originHost]=process.argv.slice(2);
const publicHost=new URL(publicBaseUrl).hostname;
const allowedHosts=['localhost','127.0.0.1','::1',publicHost];
if (!allowedHosts.includes(originHost)) allowedHosts.push(originHost);
const config={
  configVersion:1,
  server:{host:'127.0.0.1',port:Number(portText),publicBaseUrl,allowedHosts,trustProxy:false},
  workspaces:{allowedRoots:[allowedRoot],worktreeRoot},
  storage:{stateDir:`${stateDir}/devspace-state`},
  tools:{mode:'codex'},
  ui:{enabled:true},
  artifacts:{enabled:false,maxFileBytes:104857600},
  skills:{enabled:true,paths:[],agentDir},
  subagents:{enabled:false,instructions:'on-demand',providers:[]},
  logging:{level:'info',format:'json',requests:true,assets:false,toolCalls:true,shellCommands:false},
  oauth:{accessTokenTtlSeconds:3600,refreshTokenTtlSeconds:2592000,scopes:['devspace'],allowedResourceUrls:[],allowedRedirectHosts:['chatgpt.com','localhost','127.0.0.1']},
};
fs.writeFileSync(file,JSON.stringify(config,null,2)+'\n',{mode:0o600});
NODE

if [[ ! -f "$CONFIG_DIR/auth.json" ]]; then
  OWNER_TOKEN="$($NODE -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")"
  printf '{"ownerToken":"%s"}\n' "$OWNER_TOKEN" > "$CONFIG_DIR/auth.json"
  chmod 0600 "$CONFIG_DIR/auth.json"
fi

if [[ -f "$HOME/.local/share/devspace-control/state/agent-home/AGENTS.md" && ! -f "$AGENT_DIR/AGENTS.md" ]]; then
  cp "$HOME/.local/share/devspace-control/state/agent-home/AGENTS.md" "$AGENT_DIR/AGENTS.md"
fi

cat > "$INSTALL_ROOT/bin/run-devspace" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export DEVSPACE_CONFIG_DIR="$CONFIG_DIR"
exec "$NODE" "$DEVSPACE_PACKAGE/dist/cli.js" serve
EOF
chmod 0755 "$INSTALL_ROOT/bin/run-devspace"
cat > "$INSTALL_ROOT/bin/run-runtime-console" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$NODE" "$INSTALL_ROOT/bin/runtime-console.mjs" --instance "$INSTANCE" --platform-root "$INSTALL_ROOT" --config "$CONFIG_DIR/config.jsonc" --service-unit "$SERVICE" --tunnel-unit "$TUNNEL_SERVICE" --state-dir "$STATE_DIR/devspace-state" --serve "$CONSOLE_PORT"
EOF
chmod 0755 "$INSTALL_ROOT/bin/run-runtime-console"

SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$SYSTEMD_DIR"
cat > "$SYSTEMD_DIR/$SERVICE" <<EOF
[Unit]
Description=DevSpace Control sidecar instance ($INSTANCE)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_ROOT/bin/run-devspace
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
UMask=0077

[Install]
WantedBy=default.target
EOF

cat > "$SYSTEMD_DIR/$CONSOLE_SERVICE" <<EOF
[Unit]
Description=DevSpace Control - Runtime Console ($INSTANCE)
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

if [[ -n "$TUNNEL_TOKEN_FILE" ]]; then
  [[ -f "$TUNNEL_TOKEN_FILE" ]] || { echo "Tunnel token file not found: $TUNNEL_TOKEN_FILE" >&2; exit 1; }
  [[ -x "$INSTANCE_CLOUDFLARED" ]] || { echo "cloudflared not found in isolated runtime: $INSTANCE_CLOUDFLARED" >&2; exit 1; }
  INSTANCE_TOKEN_FILE="$CONFIG_ROOT/cloudflare-tunnel-token.txt"
  install -m 0600 "$TUNNEL_TOKEN_FILE" "$INSTANCE_TOKEN_FILE"
  TUNNEL_PROTOCOL_ARG=""
  [[ "$TUNNEL_PROTOCOL" == "auto" ]] || TUNNEL_PROTOCOL_ARG="--protocol $TUNNEL_PROTOCOL"
  cat > "$SYSTEMD_DIR/$TUNNEL_SERVICE" <<EOF
[Unit]
Description=DevSpace $INSTANCE dedicated Cloudflare Tunnel
After=network-online.target $SERVICE
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTANCE_CLOUDFLARED tunnel $TUNNEL_PROTOCOL_ARG --no-autoupdate --loglevel info run --token-file $INSTANCE_TOKEN_FILE
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
UMask=0077

[Install]
WantedBy=default.target
EOF

  BASE_PATH="${MCP_PATH%/mcp}"
  HEALTH_PATH="${BASE_PATH}/healthz"
  WATCHDOG_STATE="$STATE_DIR/cloudflared-watchdog-failures"
  cat > "$INSTALL_ROOT/bin/check-cloudflared" <<EOF
#!/usr/bin/env bash
set -euo pipefail
LOCAL_URL="http://127.0.0.1:${PORT}${HEALTH_PATH}"
ORIGIN_URL="https://${ORIGIN_HOST}${HEALTH_PATH}"
STATE_FILE="$WATCHDOG_STATE"
TUNNEL_SERVICE="$TUNNEL_SERVICE"

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

  cat > "$SYSTEMD_DIR/$TUNNEL_WATCHDOG_SERVICE" <<EOF
[Unit]
Description=DevSpace $INSTANCE Cloudflare Tunnel health watchdog
After=network-online.target $SERVICE $TUNNEL_SERVICE
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$INSTALL_ROOT/bin/check-cloudflared
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
UMask=0077
EOF

  cat > "$SYSTEMD_DIR/$TUNNEL_WATCHDOG_TIMER" <<EOF
[Unit]
Description=DevSpace $INSTANCE Cloudflare Tunnel health watchdog timer

[Timer]
OnBootSec=90s
OnUnitActiveSec=60s
Unit=$TUNNEL_WATCHDOG_SERVICE
Persistent=true

[Install]
WantedBy=timers.target
EOF
fi

systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE"
systemctl --user enable --now "$CONSOLE_SERVICE"
if [[ -n "$TUNNEL_TOKEN_FILE" ]]; then
  systemctl --user enable --now "$TUNNEL_SERVICE"
  systemctl --user enable --now "$TUNNEL_WATCHDOG_TIMER"
fi

deadline=$((SECONDS+30))
code=000
while (( SECONDS < deadline )); do
  code="$(curl -sS -o /dev/null --max-time 3 --connect-timeout 1 -w '%{http_code}' "http://127.0.0.1:${PORT}${MCP_PATH}" 2>/dev/null || true)"
  [[ "$code" == 401 || "$code" == 200 || "$code" == 400 || "$code" == 405 ]] && break
  sleep 1
done
[[ "$code" != 000 && "$code" != 404 ]] || { systemctl --user --no-pager status "$SERVICE" >&2 || true; exit 1; }
console_code="$(curl -sS -o /dev/null --max-time 8 --connect-timeout 2 -w '%{http_code}' "http://127.0.0.1:${CONSOLE_PORT}/api/status" 2>/dev/null || true)"
[[ "$console_code" == 200 ]] || { systemctl --user --no-pager status "$CONSOLE_SERVICE" >&2 || true; echo "Runtime Console health check failed: $console_code" >&2; exit 1; }

echo "instance=$INSTANCE"
echo "service=$SERVICE"
echo "runtime_version=$($NODE -p "require(process.argv[1]).version" "$DEVSPACE_PACKAGE/package.json")"
echo "local_mcp=http://127.0.0.1:${PORT}${MCP_PATH}"
echo "local_console=http://127.0.0.1:${CONSOLE_PORT}/"
echo "local_status=$code"
echo "public_mcp=${PUBLIC_URL%/}/mcp"
echo "tunnel_route=${ORIGIN_HOST} -> http://127.0.0.1:${PORT}"
if [[ -n "$TUNNEL_TOKEN_FILE" ]]; then
  echo "cloudflared=dedicated:$TUNNEL_SERVICE"
  echo "tunnel_protocol=$TUNNEL_PROTOCOL"
  echo "tunnel_watchdog=$TUNNEL_WATCHDOG_TIMER"
else
  echo "cloudflared=existing-tunnel-reused"
fi
