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

## Product parity contract

The web Console is not only a diagnostic dashboard. The **core management**
section must preserve the operator capabilities of the Windows Control Platform:

- Services & access: DevSpace/Tunnel start, stop, restart, all-service controls,
  public/local MCP URL copy and explicit Owner Password copy.
- Connection config: Allowed Roots, local port, public base URL, protected
  Cloudflare Tunnel token and login autostart.
- DevSpace config: runtime version, tool mode, Change Review UI, Agent Skills
  discovery/paths, subagent state, and request/tool/shell logging controls.
- Projects / Git: real repository status and Git commits plus the independent
  DevSpace Review version chain, including selection and safe code rollback.
- Logs & diagnostics: config validation, doctor, effective config, per-workspace
  tool/activity log, service logs and state paths.
- Platform config history: snapshot preview and the Windows-compatible workflow
  of loading a snapshot into the editable forms, reviewing it, then pressing
  Save. An immediate restore remains an explicitly marked advanced action.

The runtime observation pages (Overview, Runtime & versions, Connectivity, MCP
diagnostics, Workspaces & jobs, Runtime deployment) are supplementary. They must
not replace the management functions above.

The Console supports Chinese and English, light/dark appearance, keyboard focus,
accessible confirmation and reduced-motion preferences. A structured HTTP JSON
snapshot is at `/api/status`. Request timings describe origin observations;
`firstByteMs` means the origin wrote response headers and does not prove delivery
to the ChatGPT connector.

The public MCP URL is derived from the configured public base URL and can be
copied without revealing a secret. Owner Password copying is a separate,
explicitly confirmed action (`POST /api/credentials/owner`) available only on
localhost, with a same-origin request, per-process action token and a protected
local `auth.json`. No secret is included in `/api/status`, normal logs or page
HTML. The password is copied to the browser clipboard, never inserted into a
visible input, and should be moved to a password manager. To disable the copy
operation, install with `--disable-owner-copy` or omit the feature flag in a
manually configured console wrapper.

Rollback requires choosing a specific installed runtime. Candidate entries
must have an actual CLI and server file inside their instance directory; the
server SHA-256 and current process PID are rechecked immediately before a
switch. The operator must type the selected runtime ID in the confirmation
dialog. The backend saves a launcher backup, switches the CLI path, restarts
only the DevSpace service, and verifies both the new process identity and local
MCP health. On failure it restores the former launcher and requests a service
restart. The Cloudflare Tunnel and owner credential are not changed. A rollback
candidate being listed is not a guarantee that it will pass runtime health.
If target health fails, the former launcher is restored, the service is
restarted again, and the former process identity/health must also pass before
the operation reports an automatic recovery.
Windows rollback is unavailable until a verified Windows service supervisor
and safe switch transaction are implemented.

Project/code rollback is separate from runtime rollback. It uses the same hidden
Review refs as the Windows manager (`refs/devspace/control-platform/...`), makes
working-tree snapshots with a temporary Git index and `commit-tree`, checks a
reverse patch before applying it, and refuses conflicting later edits. It never
uses `git reset --hard` and never moves the repository's real Git HEAD. The
operator chooses the project and an earlier active Review version explicitly.

Managed configuration writes preserve unrelated DevSpace/OAuth fields and create
a configuration-history snapshot before changing the canonical `config.jsonc`.
Saving configuration never silently restarts DevSpace. Tunnel credentials remain
in their protected token file rather than in the ordinary config or status API.

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
