#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT=""
CONFIG=""
DEVSPACE_SERVICE=""
TUNNEL_SERVICE=""

usage() {
  cat <<'EOF'
Usage: runtime-console.sh [--root INSTANCE_ROOT] [--config CONFIG] [--service UNIT] [--tunnel-service UNIT]

Read-only DevSpace Runtime Console. It reports runtime/version/hash, service and
Tunnel state, durable Jobs, workspace sessions, and recent MCP request
diagnostics. It never prints auth tokens or owner credentials.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="${2:?missing instance root}"; shift 2 ;;
    --config) CONFIG="${2:?missing config path}"; shift 2 ;;
    --service) DEVSPACE_SERVICE="${2:?missing DevSpace service unit}"; shift 2 ;;
    --tunnel-service) TUNNEL_SERVICE="${2:?missing Tunnel service unit}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "$ROOT" ]]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
ROOT="$(cd "$ROOT" && pwd)"

if [[ -f "$ROOT/runtime-console.env" ]]; then
  source "$ROOT/runtime-console.env"
fi
DEVSPACE_SERVICE="${DEVSPACE_SERVICE:-devspace-control.service}"
TUNNEL_SERVICE="${TUNNEL_SERVICE:-devspace-control-cloudflared.service}"

RUNTIME="$ROOT/runtime"
STATE="$ROOT/state/devspace-state"
CONFIG="${CONFIG:-${DEVSPACE_CONFIG_PATH:-$ROOT/state/devspace-config/config.jsonc}}"
PACKAGE_ROOT=""
NODE=""
MAIN_PID="$(systemctl --user show "$DEVSPACE_SERVICE" -p MainPID --value 2>/dev/null || true)"
if [[ "$MAIN_PID" =~ ^[1-9][0-9]*$ && -r "/proc/$MAIN_PID/cmdline" ]]; then
  while IFS= read -r -d '' arg; do
    if [[ "$arg" == */node_modules/@waishnav/devspace/dist/cli.js ]]; then PACKAGE_ROOT="${arg%/dist/cli.js}"; break; fi
  done < "/proc/$MAIN_PID/cmdline"
  NODE="$(readlink -f "/proc/$MAIN_PID/exe" 2>/dev/null || true)"
fi
[[ -n "$NODE" ]] || NODE="$(command -v node || true)"
if [[ -z "$NODE" && -x "$RUNTIME/node/bin/node" ]]; then NODE="$RUNTIME/node/bin/node"; fi
if [[ -z "$NODE" && -d "$RUNTIME/slots" ]]; then
  NODE="$(find "$RUNTIME/slots" -type f -path '*/node/bin/node' -print -quit)"
fi
ACTIVE_SLOT=""
if [[ -n "$NODE" ]]; then
  description="$("$NODE" "$SCRIPT_DIR/runtime-rollback.mjs" --describe "$ROOT" "$CONFIG" "$PACKAGE_ROOT")"
  mapfile -t selected <<< "$description"
  NODE="${selected[0]}"; PACKAGE_ROOT="${selected[1]}"; ACTIVE_SLOT="${selected[2]}"; STATE="${selected[3]}"
fi

version="unknown"
server_hash="unavailable"
if [[ -n "$PACKAGE_ROOT" && -f "$PACKAGE_ROOT/package.json" && -n "$NODE" ]]; then
  version="$("$NODE" -e 'try{console.log(require(process.argv[1]).version||"unknown")}catch{console.log("unknown")}' "$PACKAGE_ROOT/package.json")"
fi
if [[ -n "$PACKAGE_ROOT" && -f "$PACKAGE_ROOT/dist/server.js" ]]; then
  server_hash="$(sha256sum "$PACKAGE_ROOT/dist/server.js" | awk '{print $1}')"
fi

echo "INSTANCE / RUNTIME"
echo "  root: $ROOT"
echo "  version: $version"
echo "  active-slot: ${ACTIVE_SLOT:-legacy/default}"
echo "  package-root: ${PACKAGE_ROOT:-unavailable}"
echo "  dist/server.js sha256: $server_hash"
echo "  slots:"
if [[ -d "$RUNTIME/slots" ]]; then
  find "$RUNTIME/slots" -mindepth 1 -maxdepth 1 -type d -print0 |
    while IFS= read -r -d '' slot; do
      [[ -f "$slot/READY" ]] && echo "    - $(basename "$slot")"
    done
fi

echo
echo "READINESS / TUNNEL"
echo "  DevSpace service: $(systemctl --user is-active "$DEVSPACE_SERVICE" 2>/dev/null || true)"
echo "  Tunnel service: $(systemctl --user is-active "$TUNNEL_SERVICE" 2>/dev/null || true)"
exec_start="$(systemctl --user show "$TUNNEL_SERVICE" -p ExecStart --value 2>/dev/null || true)"
configured_protocol="auto"
if [[ "$exec_start" =~ --protocol[[:space:]]+(auto|quic|http2) ]]; then
  configured_protocol="${BASH_REMATCH[1]}"
fi
actual_protocol="$(journalctl --user -u "$TUNNEL_SERVICE" --since '2 hours ago' --no-pager 2>/dev/null |
  grep -Ei 'registered tunnel connection|connection registered' |
  sed -nE 's/.*protocol=([^[:space:]]+).*/\1/p' | tail -1 || true)"
echo "  configured protocol: $configured_protocol"
echo "  actual protocol: ${actual_protocol:-unknown}"

echo
echo "DURABLE JOBS / WORKSPACES / SESSIONS"
if [[ -n "$NODE" && -n "$PACKAGE_ROOT" ]]; then
  NODE_MODULES="$(dirname "$(dirname "$PACKAGE_ROOT")")"
  SQLITE_MODULE="$NODE_MODULES/better-sqlite3"
  if [[ -d "$SQLITE_MODULE" ]]; then
    "$NODE" - "$SQLITE_MODULE" "$STATE/devspace.sqlite" "$STATE/jobs/jobs.sqlite" <<'NODE'
const fs = require("node:fs");
const Database = require(process.argv[2]);
const workspaceDb = process.argv[3];
const jobsDb = process.argv[4];
let jobs = [];
let workspaces = [];
if (fs.existsSync(jobsDb)) {
  const db = new Database(jobsDb, { readonly: true, fileMustExist: true });
  try {
    jobs = db.prepare("select id,status,workspace_root,command from durable_jobs order by created_at desc limit 20").all();
  } finally { db.close(); }
}
if (fs.existsSync(workspaceDb)) {
  const db = new Database(workspaceDb, { readonly: true, fileMustExist: true });
  try {
    workspaces = db.prepare("select id,root from workspace_sessions order by last_used_at desc limit 20").all();
  } finally { db.close(); }
}
for (const job of jobs) {
  const command = String(job.command || "").replace(/\s+/g, " ").slice(0, 96);
  console.log("  JOB " + job.status + "  " + job.id + "  " + (job.workspace_root || "") + "  " + command);
}
if (jobs.length === 0) console.log("  JOB (none)");
for (const workspace of workspaces) console.log("  WORKSPACE " + workspace.id + "  " + workspace.root);
if (workspaces.length === 0) console.log("  WORKSPACE (none)");
NODE
  else
    echo "  state query unavailable: better-sqlite3 not found"
  fi
else
  echo "  state query unavailable: runtime package/node not found"
fi

echo
echo "RECENT MCP / REQUEST DIAGNOSTICS"
journalctl --user -u "$DEVSPACE_SERVICE" -n 600 --no-pager 2>/dev/null |
  grep -E 'http_request|mcp_request|tool_call' |
  tail -40 || true
