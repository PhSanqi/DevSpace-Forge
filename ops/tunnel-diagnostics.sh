#!/usr/bin/env bash
set -euo pipefail

SERVICE=""
SINCE="2 hours ago"

usage() {
  cat <<'EOF'
Usage: tunnel-diagnostics.sh --service UNIT [--since JOURNAL_TIME]

Prints a compact Cloudflare Tunnel stability snapshot with the same metric
names used by the Windows diagnostics script.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service) SERVICE="${2:?missing systemd user unit}"; shift 2 ;;
    --since) SINCE="${2:?missing journal time}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$SERVICE" ]] || { echo '--service is required.' >&2; exit 2; }

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
journalctl --user -u "$SERVICE" --since "$SINCE" --no-pager > "$LOG"

count() {
  local pattern="$1"
  grep -Eic "$pattern" "$LOG" 2>/dev/null || true
}

exec_start="$(systemctl --user show "$SERVICE" -p ExecStart --value 2>/dev/null || true)"
configured_protocol="auto"
if [[ "$exec_start" =~ --protocol[[:space:]]+(auto|quic|http2) ]]; then
  configured_protocol="${BASH_REMATCH[1]}"
fi

actual_protocol="$(grep -Ei 'registered tunnel connection|connection registered' "$LOG" | sed -nE 's/.*protocol=([^[:space:]]+).*/\1/p' | tail -1)"
[[ -n "$actual_protocol" ]] || actual_protocol="unknown"

echo "service=$SERVICE"
echo "active=$(systemctl --user is-active "$SERVICE" 2>/dev/null || true)"
echo "configured_protocol=$configured_protocol"
echo "actual_protocol=$actual_protocol"
echo "registered=$(count 'registered tunnel connection|connection registered')"
echo "terminated=$(count 'connection terminated')"
echo "idle_timeout=$(count 'timeout: no recent network activity')"
echo "tls_handshake=$(count 'TLS handshake with edge error')"
echo "quic_dial=$(count 'Failed to dial a quic connection')"
echo "precheck_fail=$(count 'precheck.*status=fail|HTTP/2 connection is blocked or unreachable')"
