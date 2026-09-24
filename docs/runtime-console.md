# DevSpace Control Console

The Management Console is a separate, loopback-only service. It does not serve
the MCP/OAuth endpoint or own the Cloudflare Tunnel lifecycle. Linux installation
starts an independent console systemd user service (default MCP port + 1); on
Windows, run the included `ops/start-runtime-console.ps1` from the installed
Control root. Never proxy this privileged local interface to the public MCP URL.

## Identity and provenance contract

The configured runtime and the **actually running process** must be shown
separately. On Linux, the actual package is derived from the systemd service
MainPID and `/proc/PID/cmdline` pointing to the installed DevSpace CLI. A
configured `--runtime-package` or `active-slot.txt` is not evidence of the live
process. On Windows, the local launcher supplies the PID of its runtime process,
and the console reads that process's command line; if inaccessible, the actual
runtime is labeled unknown rather than guessed.

Build-time source identity is frozen with `ops/write-provenance.mjs` into
`runtime-provenance.json` and `control-provenance.json`. A Git commit is displayed
only if its manifest includes the SHA-256 matching the installed runtime
`dist/server.js` or the installed Control Console server file. Package version
alone, a development checkout HEAD, and a configured slot must **never** be
presented as the running Git revision. No secrets are included in the snapshot.

## Modules

Overview; Runtime & versions; Connectivity; MCP request diagnostics;
Workspaces & jobs; Deployment/rollback inventory. The Console supports Chinese
and English, light/dark appearance, keyboard focus, accessible confirmation and
reduced-motion preferences. A structured HTTP JSON snapshot is at `/api/status`.
Request timings describe origin observations; `firstByteMs` means the origin
wrote response headers and does not prove delivery to the ChatGPT connector.

Protected restart controls are restricted to loopback Host, same-origin POST,
an ephemeral per-process action token, and a confirmation dialog. They are not
made available in Windows instances without an explicit service supervisor.
No endpoint exposes owner passwords, tunnel tokens or OAuth credentials.

## Development acceptance

From the Control Platform repository:

```sh
node --test tests/runtime-console.test.mjs
node tests/runtime-console-preview.mjs
# separate shell; requires an isolated Chromium/Edge executable:
node tests/runtime-console-visual-audit.mjs
```

The preview uses **generated fixture data** on `127.0.0.1:17689`, not production
credentials, service control, or persistent workspace state. Browser evidence is
written to ignored `tests/.review-runtime/`. The visual audit checks 1440px and
390px, Chinese/English, dark/light, navigation/drawer, dialog focus, error,
keyboard focus and reduced motion. Actual Server production deployment is a
separate acceptance requiring a controlled rollout and explicit authorization.

## Linux operational entry

`ops/install-linux-sidecar-instance.sh --instance server --port 17677
--console-port 17678 ...` installs `devspace-control-server-console.service`.
Offline bundles ship all frontend assets plus build provenance. The existing
`17677` MCP service and its Tunnel are never restarted merely for UI inspection.
The existing plain-text `ops/runtime-console.sh` remains available as a
read-only fallback. Do not use its output as a substitute for the web console's
real-process provenance contract.
