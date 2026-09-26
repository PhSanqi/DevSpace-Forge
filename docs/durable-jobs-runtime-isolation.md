# Durable Jobs and Runtime lifecycle isolation (candidate, 2026-09-26)

## Observed failure boundary

The Linux DevSpace durable job runner uses `spawn(..., { detached: true })` and
`child.unref()`. Those calls establish a new process group/session, **not** a
new systemd cgroup. Under the current `devspace-control-server.service`
(`KillMode=control-group`), the runner remains in the Runtime unit. A Runtime
restart would therefore stop a long-running job even though its MCP request
and the job database are durable. The OursMemory production job must remain
untouched while it runs; there is no in-place migration in this candidate.

## Immediate, non-production mitigation

`runtimeRestartPreflight` inspects the *configured instance's* durable-job
SQLite database using `node:sqlite` in read-only mode. The Console refuses
runtime rollback, direct Runtime restart, and managed DevSpace/All stop or
restart when any record is `pending`, `running`, or `cancelling` (HTTP 409, `reason_code=active_jobs`,
count only). If a present job store cannot be read or has no valid schema, it
fails closed with `job_state_unavailable`. Tunnel-only actions are independent.
The Control and Runtime candidates now use the same atomic directory gate
under the configured state directory. The Control holds it across a second
job-state check and the entire Runtime operation; job launches that encounter
the gate fail closed. This closes the Console/Runtime launch-vs-restart race
only when both matching candidates are deployed. Direct/manual `systemctl`
or independent installer upgrades do not consult the gate, so this is not a
universal lifecycle lock. No production units or existing jobs are migrated
by these source changes; the production rollback acceptance remains separate.

## Minimal Linux implementation sequence

1. Extend the existing `DurableJobManager`, rather than adding a centralized
   Server/Runner. It should launch each new job in its own per-user transient
   `systemd-run --user` service (separate cgroup), with unit name derived only
   from the generated opaque job ID. Do not modify the DevSpace Runtime unit or
   Tunnel ownership. Preserve the current `jobs.sqlite` record, job ID,
   `job_logs` pagination, completion marker, and operation-ID replay contract.
2. Avoid exposing command text or project environment in `systemd-run` argv,
   unit description, journal metadata, or world-readable environment files.
   Persist a mode-0600 launch specification under the instance job metadata
   directory and pass only its *path* to the compiled job runner. Use per-job file
   logs and atomic exit marker, both owned by the user. Keep arbitrary job
   shell commands scoped by the already-approved workspace/root authority.
3. Start the transient unit with bounded resources and lifetime, confirm its
   `MainPID`/`ControlGroup`, and record the process identity and unit ID before
   reporting success. Handle unit-start failures, runner exit before DB insert,
   stale unit identity, and repeated `job_start` operation IDs. Do not fall
   back silently to the Runtime cgroup when systemd is unavailable: report an
   explicit unsupported/failure condition or a separately documented mode.
4. Reconcile job status after Runtime restart using the existing SQLite/exit
   marker path plus systemd unit state. Keep `job_cancel` targeted to the
   specific job unit/process tree, without stopping sibling jobs or Tunnel;
   honor `maxRuntimeSeconds`, retention, and graceful termination. Prove
   log/marker retention and cancellation after server reconnect, not just
   `systemctl` showing an active unit.
5. Keep Windows first-class with an independently supervised process/job
   object contract and equivalent tests. Linux `systemd-run` must remain a
   platform adapter, not leak into the cross-platform `JobRecord` contract.
   Do not claim Windows durability from Linux evidence.
6. Once new jobs are isolated, make Console/installer update paths agree on
   lifecycle policy: active legacy/in-cgroup jobs still block Runtime stop;
   isolated jobs can survive it only after process identity and resume/log
   acceptance have passed. A preflight read and restart are not atomic until
   launch and switch coordinate under one explicit gate/lock.

## Isolated evidence and remaining release gates

`tests/isolated-durable-job-cgroup.sh` starts two uniquely named *transient*
user services, stops the fake parent only, and verifies that the independent
job retains its process and writes both start and finish records. It cleans up
only the units that it created. This proves that the host's user manager can
provide separate service cgroups; it does **not** prove that DevSpace's job
manager has adopted that implementation.

Before a future release: prove source tests on both platforms, frozen package
asset inclusion (including `runtime-jobs-guard.mjs`), launch/exit/cancel/recover
fault injection, no exposed secrets, actual Linux isolated Runtime restart with
an independently running test job, and a Windows equivalent. Verify all
release-asset checksums and provenance. Do not restart the production Runtime
or migrate the live OursMemory job merely to complete the acceptance matrix.

Source-only acceptance update (2026-09-26): Linux Runtime tests 17/18
(one Windows-only skip) and Control 30/31 (one Windows-only skip);
Windows Runtime 12/18 (six Linux-only skips) and Control 31/31.
All four suites have zero failures.
The Windows Control `test.ps1 -SkipRuntimeSmoke` configuration suite passes.
The actual DurableJobManager was started inside a temporary user service;
after stopping that parent, the separate job finished and retained its ID,
status and log. A direct cross-project smoke verified that the shared gate
blocks both concurrent job launch and Runtime restart. Linux and Windows
candidate sources were checked equal after newline normalization. These are
local candidate checks, **not** immutable release or production acceptance.
The updated cancellation/timeout path persists stop intent and keeps rows
active while unit/process termination is unconfirmed; targeted fault injection
and post-reconnect cancellation pass. A separate temporary TypeScript output
was compiled and its actual Linux Runner completed a job, preserved logs and
removed the launch specification. The strict release provenance gate still
requires a clean, authorized release source; it has not been bypassed.

Windows-specific acceptance: an actual detached job remains alive after a
temporary manager process is killed *without* its process tree, and a new
manager recovers its original job ID/status/log. Both platforms now use the
same Console SQLite preflight and atomic switch gate; the previous Windows
shortcut has been removed. The Windows native existing-install updater also
atomically acquires that directory gate and invokes a packaged, read-only
job-store preflight **before** stopping any managed Runtime process. If the
gate is held, the job state cannot be read, or active jobs exist, the update
fails closed. The updater now copies both guard modules during installation;
the packaging script includes both. The installer regression confirms that
another owner's gate is preserved, unreadable job state blocks update, and
the Runtime pointer stays unchanged on refusal.

Candidate Runtime `pnpm pack` succeeded separately on Linux and Windows;
each temporary tarball was independently inspected for compiled
`durable-jobs.js`, `durable-job-runner.js`, and the stop-confirmation guard.
Both temporary candidate archives were removed after inspection. Windows
`DevSpaceControlPlatform.exe` and `Setup.exe` built in an isolated temporary
directory; no installer was run. The strict provenance fixture proves that a
dirty source cannot claim a release, while a non-strict audit labels it dirty.
No immutable release asset, release tag, deployment, or production rollback
has been created or accepted from these candidate checks.

Remaining release gates: verify a *complete* immutable, clean-source pair of
Control/Runtime artifacts and their sidecar checksums/provenance; test the
Windows native GUI's direct stop/restart path and updater with a real active
job under an installed runtime; verify service-level Windows job supervision
under the actual production lifecycle; separately authorize and validate the
production local14/local13candidate/local14 round trip. Do not treat a
parent-only kill test as evidence that every Windows process-tree termination
policy preserves a job.

Additional native GUI candidate patch (2026-09-26): the C# ServiceSupervisor
now uses the same installer/Console job-state preflight and shared switch gate
for StopDevSpace, RestartDevSpace, StopAll, RestartAll, and automatic Runtime
recovery. StopAll acquires the gate before stopping Tunnel, so a refusal does
not bring down the public endpoint. The tray's orderly "exit and stop" flow
restores its UI and refuses to dispose the KILL_ON_JOB_CLOSE process JobObject
when the gate blocks shutdown. The Windows C# test invokes these methods with
a pre-existing gate and verifies that none removes another owner's lock;
the candidate Windows GUI builds, the C# suite passes, and Control Node
31/31 passes. Forceful OS termination of the GUI/process JobObject remains a
distinct unverified durability boundary and is **not** claimed fixed. These
changes have not been released or installed.

Linux live Web management check (2026-09-26): the installed loopback Runtime
Console at 127.0.0.1:17678 serves /, /ui.css, /ui.js, /api/status and
/api/management/config with HTTP 200; the official Control provenance is
v0.6.4 @ 778b95b, source_dirty=false, and the server plus all three UI
asset SHA-256 values match that manifest. Runtime actual/configured both
point at local14 and DevSpace/Tunnel are active. This establishes deployed
HTTP/API and asset integrity, **not** a visual browser acceptance. A headless
Chrome attempt *without* --no-sandbox aborts because the host's SUID
chrome-sandbox is owned by nobody rather than root; user namespaces are
unavailable. No system-wide sandbox or proxy settings were changed. The
long-job isolation gate exists only in the candidate, not the official
v0.6.4 Linux Web Console.

Isolated native Windows GUI acceptance update (2026-09-26): the C# fixture
now uses the actual packaged Node/SQLite CLI path, seeds an active
`durable_jobs` record and attaches a sacrificial, independently created Node
process as the GUI's Runtime handle. Stop, restart, stop-all and orderly exit
refuse the operation **before** terminating that process. Once the fixture
row is terminal, stop succeeds and the shared lock is released. The
ServiceSupervisor now also checks actual process exit before clearing its
Runtime handle or reporting stopped; an unconfirmed stop fails closed. The
Windows full configuration suite passes. This does not emulate an operating
system's forced process termination and therefore leaves KILL_ON_JOB_CLOSE
durability as a separate TODO. Tests only created/cleaned their own
sacrificial process and temporary state.

The production server's read-only SQLite check currently reports zero
pending/running/cancelling rows; the two most recent OursMemory records are
terminal `failed` (exit 2). This supersedes the earlier historical claim
that job_87aa008eaff74745 is *still running*. No production rollback was
attempted: clean preflight alone is not authorization for switching Runtime.
