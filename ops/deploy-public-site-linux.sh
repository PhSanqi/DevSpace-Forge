#!/usr/bin/env bash
# Deploy only the public, static product site; never restart DevSpace or Tunnel.
set -euo pipefail
umask 022

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${DEVSPACE_SITE_ROOT:-$HOME/.local/share/devspace-forge-public-site}"
PORT="${DEVSPACE_SITE_PORT:-17679}"
SERVICE="devspace-forge-public-site.service"
NODE="$(command -v node)"
[[ "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1024 && "$PORT" -le 65535 ]] || {
  echo "Invalid DEVSPACE_SITE_PORT" >&2; exit 2;
}
[[ -f "$SOURCE/site/index.html" && -f "$SOURCE/site/docs/index.html" && -f "$SOURCE/ops/public-site-server.mjs" ]] || {
  echo "Missing public site sources" >&2; exit 2;
}
if find "$SOURCE/site" -type l -print -quit | grep -q .; then
  echo "Refusing to deploy symlinks in public files" >&2; exit 2;
fi
mkdir -p "$ROOT/releases" "$HOME/.config/systemd/user"
ROOT="$(cd "$ROOT" && pwd)"
CONFIG="$ROOT/public-site.env"
REQUESTED_SITE_URL="$(printenv DEVSPACE_SITE_PUBLIC_URL || true)"
REQUESTED_REPO_URL="$(printenv DEVSPACE_SITE_REPO_URL || true)"
SITE_URL=""
REPO_URL=""
if [[ -f "$CONFIG" ]]; then
  SITE_URL="$(sed -n 's/^DEVSPACE_SITE_PUBLIC_URL=//p' "$CONFIG" | head -1)"
  REPO_URL="$(sed -n 's/^DEVSPACE_SITE_REPO_URL=//p' "$CONFIG" | head -1)"
fi
[[ -z "$REQUESTED_SITE_URL" ]] || SITE_URL="$REQUESTED_SITE_URL"
[[ -z "$REQUESTED_REPO_URL" ]] || REPO_URL="$REQUESTED_REPO_URL"
if [[ -z "$REPO_URL" ]]; then
  REMOTE="$(git -C "$SOURCE" remote get-url origin)"
  case "$REMOTE" in
    https://github.com/*) REPO_URL="$REMOTE" ;;
    git@github.com:*) REPO_URL="https://github.com/"$(printf '%s' "$REMOTE" | cut -d: -f2-) ;;
    *) echo "Set DEVSPACE_SITE_REPO_URL to the public repository URL" >&2; exit 2 ;;
  esac
  REPO_URL="$(printf '%s' "$REPO_URL" | sed 's/[.]git$//')"
fi
[[ -n "$SITE_URL" ]] || { echo "Set DEVSPACE_SITE_PUBLIC_URL to your HTTPS site origin" >&2; exit 2; }
SITE_URL="$SITE_URL" REPO_URL="$REPO_URL" "$NODE" - <<'JS'
const site=new URL(process.env.SITE_URL),repo=new URL(process.env.REPO_URL);
if(site.protocol!=='https:'||site.username||site.password||site.pathname!=='/'||site.search||site.hash)throw Error('Invalid HTTPS site origin');
if(repo.protocol!=='https:'||repo.username||repo.password||repo.search||repo.hash||repo.pathname.split('/').filter(Boolean).length!==2)throw Error('Invalid repository URL');
JS
SITE_URL="$(SITE_URL="$SITE_URL" "$NODE" -p 'new URL(process.env.SITE_URL).origin')"
REPO_URL="$(REPO_URL="$REPO_URL" "$NODE" -p 'new URL(process.env.REPO_URL).origin+new URL(process.env.REPO_URL).pathname.replace(/\/$/,"")')"
umask 077
printf 'DEVSPACE_SITE_PUBLIC_URL=%s\nDEVSPACE_SITE_REPO_URL=%s\n' "$SITE_URL" "$REPO_URL" > "$CONFIG"
chmod 600 "$CONFIG"
umask 022
ID="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$SOURCE" rev-parse --short HEAD)"
DEST="$(mktemp -d "$ROOT/releases/$ID-XXXXXX")"
cp -R "$SOURCE/site" "$DEST/site"
cp "$SOURCE/ops/public-site-server.mjs" "$DEST/server.mjs"
SITE_STAGE_ROOT="$DEST/site" SITE_URL="$SITE_URL" REPO_URL="$REPO_URL" "$NODE" --input-type=module - <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root=process.env.SITE_STAGE_ROOT;
for(const name of ['index.html','docs/index.html','robots.txt','sitemap.xml']){
  const path=join(root,name);
  const content=readFileSync(path,'utf8')
    .replaceAll('__PUBLIC_SITE_URL__',process.env.SITE_URL)
    .replaceAll('__PUBLIC_REPO_URL__',process.env.REPO_URL);
  if(content.includes('__PUBLIC_'))throw Error('Unresolved public-site template value: '+name);
  writeFileSync(path,content);
}
JS
chmod -R u+rwX,go+rX "$DEST"
PREVIOUS="$(readlink "$ROOT/current" || true)"
ln -s "$DEST" "$ROOT/current.next"
mv -Tf "$ROOT/current.next" "$ROOT/current"

UNIT="$HOME/.config/systemd/user/$SERVICE"
cat > "$UNIT" <<EOF
[Unit]
Description=DevSpace-Forge public static site (independent from MCP and Console)
After=network.target

[Service]
Type=simple
EnvironmentFile=$CONFIG
ExecStart=$NODE $ROOT/current/server.mjs --root $ROOT/current/site --port $PORT
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
UMask=0027
MemoryMax=128M
TasksMax=64

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
HEALTHY=0
if systemctl --user enable "$SERVICE" && systemctl --user restart "$SERVICE"; then
  for attempt in $(seq 1 40); do
    if curl --fail --silent --max-time 2 "http://127.0.0.1:$PORT/" >/dev/null; then
      HEALTHY=1
      break
    fi
    sleep 0.25
  done
fi
if [[ "$HEALTHY" != 1 ]]; then
  echo "Site health failed; restoring previous release" >&2
  if [[ -n "$PREVIOUS" ]]; then
    ln -s "$PREVIOUS" "$ROOT/current.next"
    mv -Tf "$ROOT/current.next" "$ROOT/current"
    systemctl --user restart "$SERVICE" || true
  else
    systemctl --user stop "$SERVICE" || true
  fi
  exit 1
fi
printf 'SITE_SERVICE=%s\nSITE_PORT=%s\nSITE_RELEASE=%s\nSITE_PREVIOUS=%s\n' "$SERVICE" "$PORT" "$DEST" "$PREVIOUS"
