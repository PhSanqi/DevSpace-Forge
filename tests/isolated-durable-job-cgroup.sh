#!/usr/bin/env bash
# Non-production proof: an independently supervised user service survives a
# different transient parent service stopping. Never touches installed units.
set -euo pipefail
command -v systemd-run >/dev/null
command -v systemctl >/dev/null
systemctl --user is-system-running >/dev/null || true
root=$(mktemp -d "${TMPDIR:-/tmp}/devspace-job-isolation.XXXXXXXX")
unit_prefix="devspace-cgroup-proof-$(date +%s)-$$"
parent="${unit_prefix}-parent.service"
job="${unit_prefix}-job.service"
cleanup(){
  systemctl --user stop "$job" "$parent" >/dev/null 2>&1 || true
  rm -rf -- "$root"
}
trap cleanup EXIT
cat > "$root/job.sh" <<'JOB'
#!/usr/bin/env bash
set -euo pipefail
printf 'STARTED\n' >> "$1"
sleep 5
printf 'FINISHED\n' >> "$1"
JOB
chmod 700 "$root/job.sh"
systemd-run --user --quiet --unit="$parent" --collect --property=Type=exec /bin/sleep 20
systemd-run --user --quiet --unit="$job" --collect --property=Type=exec --property=RuntimeMaxSec=20 /bin/bash "$root/job.sh" "$root/output.log"
parent_cgroup=$(systemctl --user show "$parent" -p ControlGroup --value)
job_cgroup=$(systemctl --user show "$job" -p ControlGroup --value)
job_pid=$(systemctl --user show "$job" -p MainPID --value)
[[ -n "$parent_cgroup" && -n "$job_cgroup" && "$parent_cgroup" != "$job_cgroup" ]]
[[ "$job_pid" =~ ^[1-9][0-9]*$ ]]
systemctl --user stop "$parent"
kill -0 "$job_pid"
for i in $(seq 1 30); do
  [[ -f "$root/output.log" ]] && grep -q '^FINISHED$' "$root/output.log" && break
  sleep 0.25
done
grep -q '^STARTED$' "$root/output.log"
grep -q '^FINISHED$' "$root/output.log"
printf 'ISOLATED_CGROUP_PASS parent_stopped=1 job_survived=1 completion_marker=1 log_preserved=1\n'
