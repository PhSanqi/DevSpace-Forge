import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, utimesSync, writeFileSync, existsSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { DurableJobManager, canUseSystemdUserJobIsolation, durableJobSystemdUnitName } from "./durable-jobs.js";
import { resolveProjectEnvironment, getRuntimeDiagnostics } from "./runtime-env.js";

function delay(ms: number): Promise<void> {
  let timer: NodeJS.Timeout;
  return new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  }).finally(() => {
    clearTimeout(timer);
  });
}

function shellCommands(...commands: string[]): string {
  return commands.join(process.platform === "win32" ? "&" : "; ");
}

function longRunningCommand(): string {
  return process.platform === "win32"
    ? 'ping 127.0.0.1 -n 61 >NUL'
    : "sleep 60";
}

function delayedNodeCommand(delayMs = 600): string {
  const node = process.platform === "win32"
    ? `"${process.execPath}"`
    : JSON.stringify(process.execPath);
  return `${node} -e "setTimeout(() => console.log('restart-done'), ${delayMs})"`;
}

test("DurableJobManager: starts, tracks, and reads logs from detached job", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-test-"));
  const mgr = new DurableJobManager(tempDir);

  try {
    const job = mgr.startJob({
      workspaceId: "test_ws",
      workspaceRoot: process.cwd(),
      command: shellCommands("echo line1", "echo line2"),
      workingDirectory: process.cwd(),
    });

    assert.ok(job.id.startsWith("job_"));
    assert.equal(job.status, "running");

    // Wait for completion
    let finalJob = mgr.getJob(job.id);
    for (let i = 0; i < 20; i++) {
      if (finalJob?.status !== "running") break;
      await delay(100);
      finalJob = mgr.getJob(job.id);
    }

    assert.equal(finalJob?.status, "succeeded");
    assert.equal(finalJob?.exitCode, 0);

    const logs = mgr.readLogs(job.id);
    assert.ok(logs.content.includes("line1"));
    assert.ok(logs.content.includes("line2"));
    assert.equal(logs.hasMore, false);
  } finally {
    mgr.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: preserves explicit environment through the job supervisor", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-env-test-"));
  const mgr = new DurableJobManager(tempDir);
  try {
    const node = process.platform === "win32" ? `"${process.execPath}"` : JSON.stringify(process.execPath);
    const job = mgr.startJob({
      workspaceId: "env_ws", workspaceRoot: process.cwd(),
      command: `${node} -e "console.log(process.env.DEVSPACE_TEST_ENV)"`,
      workingDirectory: process.cwd(), env: { DEVSPACE_TEST_ENV: "supervisor-env-ok" },
    });
    let current = mgr.getJob(job.id);
    for (let i = 0; i < 30 && current?.status === "running"; i++) {
      await delay(100); current = mgr.getJob(job.id);
    }
    assert.equal(current?.status, "succeeded");
    assert.match(mgr.readLogs(job.id).content, /supervisor-env-ok/);
  } finally {
    mgr.close(); rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: Linux user-systemd jobs use an independent cgroup", {
  skip: !canUseSystemdUserJobIsolation(),
}, async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-cgroup-test-"));
  const mgr = new DurableJobManager(tempDir);
  let jobId = "";
  try {
    const job = mgr.startJob({
      workspaceId: "cgroup_ws", workspaceRoot: process.cwd(),
      command: "sleep 60", workingDirectory: process.cwd(), env: { DEVSPACE_CGROUP_TEST: "1" },
    });
    jobId = job.id;
    await delay(250);
    const current = mgr.getJob(job.id);
    assert.ok(current?.pid);
    const jobCgroup = readFileSync(`/proc/${current.pid}/cgroup`, "utf8");
    const selfCgroup = readFileSync("/proc/self/cgroup", "utf8");
    assert.notEqual(jobCgroup, selfCgroup);
    assert.match(jobCgroup, new RegExp(durableJobSystemdUnitName(job.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const unitArgs = spawnSync("systemctl", ["--user", "show", durableJobSystemdUnitName(job.id), "-p", "ExecStart", "--value"], { encoding: "utf8" });
    assert.equal(unitArgs.status, 0);
    assert.doesNotMatch(unitArgs.stdout, /sleep 60/, "the user-systemd unit must not expose the job command");
    assert.deepEqual(readdirSync(join(tempDir, "jobs", "meta")).filter((name) => name.endsWith(".env.json")), []);
    assert.equal(mgr.cancelJob(job.id).success, true);
    jobId = "";
  } finally {
    if (jobId && mgr.getJob(jobId)?.status === "running") mgr.cancelJob(jobId);
    mgr.close(); rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: real job survives its transient manager service stopping and reconnects with logs", {
  skip: !canUseSystemdUserJobIsolation(),
}, async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-job-runtime-stop-test-"));
  const parentUnit = `devspace-test-parent-${process.pid}-${Date.now() % 1_000_000}.service`;
  const state = join(tempDir, "state");
  const idFile = join(tempDir, "job-id.json");
  const script = join(tempDir, "launch.mjs");
  let manager: DurableJobManager | undefined;
  let jobId = "";
  try {
    const modulePath = fileURLToPath(new URL("./durable-jobs.ts", import.meta.url));
    const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => console.log('after-parent-stop'), 2500)"`;
    writeFileSync(script, [
      `import { writeFileSync } from 'node:fs';`,
      `import { DurableJobManager } from ${JSON.stringify(modulePath)};`,
      `const manager = new DurableJobManager(${JSON.stringify(state)});`,
      `const job = manager.startJob({workspaceId:'stop_ws',workspaceRoot:process.cwd(),workingDirectory:process.cwd(),command:${JSON.stringify(command)}});`,
      `writeFileSync(${JSON.stringify(idFile)},JSON.stringify({id:job.id,status:job.status}));`,
      `setInterval(() => {},1000);`,
    ].join("\n"));
    const started = spawnSync("systemd-run", ["--user", `--unit=${parentUnit}`, "--collect", "--property=Type=exec",
      `--working-directory=${process.cwd()}`, process.execPath, "--import", "tsx", script],
    { encoding: "utf8", timeout: 8_000 });
    assert.equal(started.status, 0, "the isolated test manager service must start");
    for (let i = 0; i < 70 && !existsSync(idFile); i++) await delay(100);
    assert.ok(existsSync(idFile), "the manager must publish the durable job handle");
    const created = JSON.parse(readFileSync(idFile, "utf8")) as { id: string; status: string };
    jobId = created.id;
    assert.equal(created.status, "running");
    manager = new DurableJobManager(state);
    const before = manager.getJob(jobId);
    assert.ok(before?.pid);
    const parentPid = Number(spawnSync("systemctl", ["--user", "show", parentUnit, "-p", "MainPID", "--value"], { encoding: "utf8" }).stdout.trim());
    assert.ok(parentPid > 0);
    assert.notEqual(readFileSync(`/proc/${parentPid}/cgroup`, "utf8"), readFileSync(`/proc/${before.pid}/cgroup`, "utf8"));
    assert.equal(spawnSync("systemctl", ["--user", "stop", parentUnit], { encoding: "utf8", timeout: 8_000 }).status, 0);
    let current = manager.getJob(jobId);
    for (let i = 0; i < 65 && current?.status === "running"; i++) {
      await delay(100); current = manager.getJob(jobId);
    }
    assert.equal(current?.status, "succeeded", "stopping the manager must not terminate its durable job");
    assert.match(manager.readLogs(jobId).content, /after-parent-stop/);
    assert.equal(manager.listJobs("stop_ws", 10).some(row => row.id === jobId), true);
  } finally {
    if (jobId && manager?.getJob(jobId)?.status === "running") manager.cancelJob(jobId);
    manager?.close();
    spawnSync("systemctl", ["--user", "stop", parentUnit], { encoding: "utf8", timeout: 8_000 });
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: Windows detached job survives termination of its manager process", {
  skip: process.platform !== "win32",
}, async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-job-windows-parent-test-"));
  const state = join(tempDir, "state");
  const handleFile = join(tempDir, "handle.json");
  const parentScript = join(tempDir, "parent.mjs");
  const modulePath = new URL("./durable-jobs.ts", import.meta.url).href;
  const stderrPath = join(tempDir, "parent-stderr.log");
  const command = `"${process.execPath}" -e "setTimeout(()=>console.log('windows-parent-survived'),3200)"`;
  writeFileSync(parentScript, [
    "import {writeFileSync} from 'node:fs';",
    `import {DurableJobManager} from ${JSON.stringify(modulePath)};`,
    `const manager=new DurableJobManager(${JSON.stringify(state)});`,
    `const job=manager.startJob({workspaceId:'windows_parent_test',workspaceRoot:process.cwd(),workingDirectory:process.cwd(),command:${JSON.stringify(command)}});`,
    `writeFileSync(${JSON.stringify(handleFile)},JSON.stringify({id:job.id,status:job.status,pid:job.pid}));`,
    "setInterval(()=>{},1000);",
  ].join("\n"));
  const stderrFd = openSync(stderrPath, "w", 0o600);
  let parent;
  try {
    parent = spawn(process.execPath, ["--import", "tsx", parentScript], {
      cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "ignore", stderrFd],
    });
  } finally {
    closeSync(stderrFd);
  }
  let manager: DurableJobManager | undefined;
  let jobId = "";
  try {
    assert.ok(parent.pid, "the temporary manager must have a PID");
    for (let i = 0; i < 80 && !existsSync(handleFile); i++) await delay(100);
    assert.ok(existsSync(handleFile), "manager must publish the independent job handle: " + readFileSync(stderrPath, "utf8"));
    const handle = JSON.parse(readFileSync(handleFile, "utf8")) as { id: string; status: string; pid: number };
    jobId = handle.id;
    assert.equal(handle.status, "running");
    assert.ok(handle.pid);
    const killed = spawnSync("taskkill.exe", ["/pid", String(parent.pid), "/f"], {
      encoding: "utf8", windowsHide: true, timeout: 8_000,
    });
    assert.equal(killed.status, 0, "stop only the temporary parent PID, not its process tree");
    manager = new DurableJobManager(state);
    assert.ok(manager.getJob(jobId), "a new manager must recover the original job record");
    let current = manager.getJob(jobId);
    for (let i = 0; i < 80 && current?.status === "running"; i++) {
      await delay(100); current = manager.getJob(jobId);
    }
    assert.equal(current?.status, "succeeded", "child must survive its parent terminating");
    assert.match(manager.readLogs(jobId).content, /windows-parent-survived/);
    assert.equal(manager.listJobs("windows_parent_test", 10).some(row => row.id === jobId), true);
  } finally {
    if (jobId && manager?.getJob(jobId)?.status === "running") manager.cancelJob(jobId);
    manager?.close();
    if (parent.pid) spawnSync("taskkill.exe", ["/pid", String(parent.pid), "/f"], {
      stdio: "ignore", windowsHide: true, timeout: 8_000,
    });
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: Linux fails closed when systemd isolation is disabled", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-fallback-test-"));
  const previous = process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS;
  process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS = "1";
  const mgr = new DurableJobManager(tempDir);
  try {
    const job = mgr.startJob({
      workspaceId: "fallback_ws", workspaceRoot: process.cwd(),
      command: shellCommands("echo fallback-ok"), workingDirectory: process.cwd(),
    });
    let current = mgr.getJob(job.id);
    for (let i = 0; i < 30 && current?.status === "running"; i++) {
      await delay(100); current = mgr.getJob(job.id);
    }
    if (process.platform === "linux") {
      assert.equal(current?.status, "failed");
      assert.match(current?.error ?? "", /isolation is unavailable/);
      assert.doesNotMatch(mgr.readLogs(job.id).content, /fallback-ok/);
    } else {
      assert.equal(current?.status, "succeeded");
      assert.match(mgr.readLogs(job.id).content, /fallback-ok/);
    }
  } finally {
    mgr.close(); rmSync(tempDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS;
    else process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS = previous;
  }
});

test("DurableJobManager: a runtime switch gate rejects a concurrent job start", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-gate-test-"));
  const mgr = new DurableJobManager(tempDir);
  const gate = join(tempDir, ".runtime-switch-gate");
  try {
    mkdirSync(gate);
    const job = mgr.startJob({
      workspaceId: "gate_ws", workspaceRoot: process.cwd(),
      command: shellCommands("echo must-not-run"), workingDirectory: process.cwd(),
    });
    assert.equal(job.status, "failed");
    assert.match(job.error ?? "", /runtime switch gate/);
    assert.equal(existsSync(gate), true, "a rejected starter must not release the Console gate");
    assert.equal(mgr.readLogs(job.id).content, "");
    assert.deepEqual(readdirSync(join(tempDir, "jobs", "meta")).filter(name => name.endsWith(".env.json")), []);
  } finally {
    mgr.close(); rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: a failed systemd-run never falls back or leaves an environment snapshot", {
  skip: !canUseSystemdUserJobIsolation(),
}, () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-start-fail-test-"));
  const fakeBin = join(tempDir, "fake-bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "systemd-run"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = fakeBin + delimiter + (previousPath || "");
  const mgr = new DurableJobManager(tempDir);
  try {
    const job = mgr.startJob({
      workspaceId: "fail_ws", workspaceRoot: process.cwd(),
      command: shellCommands("echo must-not-run"), workingDirectory: process.cwd(),
    });
    assert.equal(job.status, "failed");
    assert.match(job.error ?? "", /systemd durable job launch failed/);
    assert.equal(mgr.readLogs(job.id).content, "");
    assert.deepEqual(readdirSync(join(tempDir, "jobs", "meta")).filter(name => name.endsWith(".env.json")), []);
    assert.equal(existsSync(join(tempDir, ".runtime-switch-gate")), false);
  } finally {
    mgr.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: reaps only stale inactive launch hand-offs outside the launch gate", {
  skip: process.platform !== "linux",
}, () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-orphan-test-"));
  const mgr = new DurableJobManager(tempDir);
  const meta = join(tempDir, "jobs", "meta");
  const orphan = join(meta, "job_aaaaaaaaaaaaaaaa.env.json");
  const recent = join(meta, "job_bbbbbbbbbbbbbbbb.env.json");
  const gate = join(tempDir, ".runtime-switch-gate");
  try {
    writeFileSync(orphan, "temporary hand-off", { mode: 0o600 });
    writeFileSync(recent, "new hand-off", { mode: 0o600 });
    const old = new Date(Date.now() - 120_000);
    utimesSync(orphan, old, old);
    mkdirSync(gate);
    mgr.reconcile();
    assert.equal(existsSync(orphan), true, "never reap during a concurrent launch/switch");
    rmdirSync(gate);
    mgr.reconcile();
    assert.equal(existsSync(orphan), false, "stale inactive generated hand-offs must not retain credentials");
    assert.equal(existsSync(recent), true, "a recently written launch hand-off remains protected");
  } finally {
    mgr.close(); rmSync(tempDir, { recursive: true, force: true });
  }
});

test("durable job runner removes malformed environment hand-off without logging its contents", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-env-invalid-test-"));
  try {
    const marker = join(tempDir, "job.exit");
    const environment = join(tempDir, "job.env.json");
    writeFileSync(environment, "{SENSITIVE_ENV_VALUE_DO_NOT_LOG");
    const runner = fileURLToPath(new URL("./durable-job-runner.ts", import.meta.url));
    const result = spawnSync(process.execPath,
      ["--import", "tsx", runner, marker, "echo must-not-run", environment],
      { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 });
    assert.equal(result.status, 1);
    assert.equal(existsSync(environment), false);
    assert.equal(JSON.parse(readFileSync(marker, "utf8")).exitCode, 1);
    assert.match(result.stderr, /environment hand-off could not be read/);
    assert.doesNotMatch(result.stderr, /SENSITIVE_ENV_VALUE_DO_NOT_LOG/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: ambiguous systemd launch stays tracked until unit exits", {
  skip: !canUseSystemdUserJobIsolation(),
}, () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-ambiguous-test-"));
  const fakeBin = join(tempDir, "fake-bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "systemd-run"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  writeFileSync(join(fakeBin, "systemctl"), [
    "#!/bin/sh", "case \"$*\" in",
    "  *is-active*) if [ \"$FAKE_UNIT_ACTIVE\" = 1 ]; then exit 0; elif [ \"$FAKE_UNIT_ACTIVE\" = unknown ]; then exit 1; else exit 3; fi ;;",
    "  *show*) echo 0; exit 0 ;;",
    "  *stop*) exit 1 ;;",
    "esac", "exit 1", "",
  ].join("\n"), { mode: 0o700 });
  const previousPath = process.env.PATH;
  const previousActive = process.env.FAKE_UNIT_ACTIVE;
  process.env.PATH = fakeBin + delimiter + (previousPath || "");
  process.env.FAKE_UNIT_ACTIVE = "1";
  const mgr = new DurableJobManager(tempDir);
  try {
    const job = mgr.startJob({
      workspaceId: "uncertain_ws", workspaceRoot: process.cwd(),
      command: shellCommands("echo must-not-run"), workingDirectory: process.cwd(),
    });
    assert.equal(job.status, "running", "a potentially live unit must block rollback");
    assert.match(job.error ?? "", /confirmation failed/);
    assert.equal(readdirSync(join(tempDir, "jobs", "meta")).filter(name => name.endsWith(".env.json")).length, 1);
    process.env.FAKE_UNIT_ACTIVE = "unknown";
    mgr.reconcile();
    assert.equal(mgr.getJob(job.id)?.status, "running", "a failed status query must not clear a possibly active unit");
    process.env.FAKE_UNIT_ACTIVE = "0";
    mgr.reconcile();
    assert.equal(mgr.getJob(job.id)?.status, "failed");
    assert.deepEqual(readdirSync(join(tempDir, "jobs", "meta")).filter(name => name.endsWith(".env.json")), []);
  } finally {
    mgr.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousActive === undefined) delete process.env.FAKE_UNIT_ACTIVE;
    else process.env.FAKE_UNIT_ACTIVE = previousActive;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: unconfirmed cancel and timeout remain active until stop is verified", {
  skip: process.platform !== "linux",
}, () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-stop-unknown-test-"));
  const fakeBin = join(tempDir, "fake-bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "systemctl"), [
    "#!/bin/sh", 'case "$*" in',
    '  *is-active*) case "$FAKE_UNIT_ACTIVE" in 1) exit 0 ;; unknown) exit 1 ;; *) exit 3 ;; esac ;;',
    '  *stop*) exit 1 ;;',
    "esac", "exit 1", "",
  ].join("\n"), { mode: 0o700 });
  const previousPath = process.env.PATH;
  const previousActive = process.env.FAKE_UNIT_ACTIVE;
  const mgr = new DurableJobManager(tempDir);
  const db = new Database(join(tempDir, "jobs", "jobs.sqlite"));
  const now = Math.floor(Date.now() / 1000);
  const ids = {
    cancel: "job_aaaaaaaaaaaaaaaa",
    timeout: "job_bbbbbbbbbbbbbbbb",
    marker: "job_cccccccccccccccc",
  };
  try {
    const insert = db.prepare(`
      INSERT INTO durable_jobs
        (id, workspace_id, workspace_root, command, working_directory, pid, pgid, status,
         exit_code, signal, log_path, created_at, started_at, ended_at, last_heartbeat,
         max_runtime_seconds, error)
      VALUES (?, 'test', ?, 'echo safe', ?, NULL, NULL, 'running',
        NULL, NULL, ?, ?, ?, NULL, ?, ?, NULL)
    `);
    for (const [kind, id] of Object.entries(ids)) {
      const started = kind === "cancel" ? now : now - 20;
      insert.run(id, tempDir, tempDir, join(tempDir, "jobs", "logs", `${id}.log`),
        started, started, now, 1);
    }
    process.env.PATH = fakeBin + delimiter + (previousPath || "");
    process.env.FAKE_UNIT_ACTIVE = "1";
    const cancellation = mgr.cancelJob(ids.cancel);
    assert.equal(cancellation.success, false, "failed stop must not claim cancellation");
    assert.equal(mgr.getJob(ids.cancel)?.status, "running");
    mgr.reconcile();
    assert.equal(mgr.getJob(ids.timeout)?.status, "running", "timeout alone is not proof of exit");
    assert.match(mgr.getJob(ids.timeout)?.error ?? "", /maxRuntimeSeconds/);
    process.env.FAKE_UNIT_ACTIVE = "unknown";
    mgr.reconcile();
    assert.equal(mgr.getJob(ids.cancel)?.status, "running", "unknown unit state remains blocking");
    assert.equal(mgr.getJob(ids.timeout)?.status, "running");
    // A late success marker must not turn an already-timed-out job into success.
    writeFileSync(join(tempDir, "jobs", "meta", `${ids.marker}.exit`),
      JSON.stringify({ exitCode: 0, signal: null, endedAt: now }));
    assert.equal(mgr.getJob(ids.marker)?.status, "failed");
    process.env.FAKE_UNIT_ACTIVE = "0";
    mgr.reconcile();
    assert.equal(mgr.getJob(ids.cancel)?.status, "cancelled");
    assert.equal(mgr.getJob(ids.timeout)?.status, "failed");
    assert.match(mgr.getJob(ids.timeout)?.error ?? "", /maxRuntimeSeconds/);
  } finally {
    db.close(); mgr.close();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousActive === undefined) delete process.env.FAKE_UNIT_ACTIVE;
    else process.env.FAKE_UNIT_ACTIVE = previousActive;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: cancels running job and updates record", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-cancel-test-"));
  const mgr = new DurableJobManager(tempDir);

  try {
    const job = mgr.startJob({
      workspaceId: "test_ws",
      workspaceRoot: process.cwd(),
      command: longRunningCommand(),
      workingDirectory: process.cwd(),
    });

    assert.equal(job.status, "running");
    const cancelRes = mgr.cancelJob(job.id);
    assert.equal(cancelRes.success, true);

    const postCancel = mgr.getJob(job.id);
    assert.equal(postCancel?.status, "cancelled");
  } finally {
    mgr.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: reconnect preserves job handle and confirms cancellation", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-reconnect-cancel-test-"));
  let first: DurableJobManager | undefined;
  let second: DurableJobManager | undefined;
  let jobId = "";
  try {
    first = new DurableJobManager(tempDir);
    const job = first.startJob({
      workspaceId: "reconnect_ws", workspaceRoot: process.cwd(),
      command: shellCommands("echo reconnect-started", longRunningCommand()),
      workingDirectory: process.cwd(),
    });
    jobId = job.id;
    assert.equal(job.status, "running");
    for (let i = 0; i < 30 && !first.readLogs(jobId).content.includes("reconnect-started"); i++) await delay(100);
    assert.match(first.readLogs(jobId).content, /reconnect-started/);
    first.close();
    first = undefined;
    second = new DurableJobManager(tempDir);
    assert.equal(second.getJob(jobId)?.status, "running");
    second.cancelJob(jobId);
    let current = second.getJob(jobId);
    for (let i = 0; i < 60 && current?.status === "running"; i++) {
      await delay(100);
      second.reconcile();
      current = second.getJob(jobId);
    }
    assert.equal(current?.status, "cancelled");
    assert.equal(second.listJobs("reconnect_ws", 10).some(row => row.id === jobId), true);
    assert.match(second.readLogs(jobId).content, /reconnect-started/);
  } finally {
    if (jobId && second?.getJob(jobId)?.status === "running") second.cancelJob(jobId);
    first?.close();
    second?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: log pagination with maxLines preserves nextOffset", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-pagination-test-"));
  const mgr = new DurableJobManager(tempDir);

  try {
    const job = mgr.startJob({
      workspaceId: "test_ws",
      workspaceRoot: process.cwd(),
      command: shellCommands("echo line-one", "echo line-two", "echo line-three"),
      workingDirectory: process.cwd(),
    });

    for (let i = 0; i < 20; i++) {
      const current = mgr.getJob(job.id);
      if (current?.status !== "running") break;
      await delay(100);
    }

    const chunk1 = mgr.readLogs(job.id, { maxLines: 1 });
    assert.equal(chunk1.content, "line-one");
    assert.equal(chunk1.hasMore, true);

    const chunk2 = mgr.readLogs(job.id, { offset: chunk1.nextOffset });
    assert.ok(chunk2.content.includes("line-two"));
    assert.ok(chunk2.content.includes("line-three"));
  } finally {
    mgr.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: prunes completed jobs after retention", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-retention-test-"));
  const mgr = new DurableJobManager(tempDir, {
    completedRetentionSeconds: 60,
    maxCompletedJobs: 100,
  });

  try {
    const job = mgr.startJob({
      workspaceId: "test_ws",
      workspaceRoot: process.cwd(),
      command: "echo retained",
      workingDirectory: process.cwd(),
    });

    let finalJob = mgr.getJob(job.id);
    for (let i = 0; i < 20; i++) {
      if (finalJob?.status !== "running") break;
      await delay(100);
      finalJob = mgr.getJob(job.id);
    }
    assert.equal(finalJob?.status, "succeeded");
    assert.ok(finalJob?.endedAt);

    const pruned = mgr.pruneCompleted((finalJob?.endedAt ?? 0) + 61);
    assert.equal(pruned, 1);
    assert.equal(mgr.getJob(job.id), null);
  } finally {
    mgr.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: reconciles a detached job after manager restart", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-restart-test-"));
  let first: DurableJobManager | undefined;
  let second: DurableJobManager | undefined;
  try {
    first = new DurableJobManager(tempDir);
    const job = first.startJob({
      workspaceId: "restart_ws",
      workspaceRoot: process.cwd(),
      command: delayedNodeCommand(),
      workingDirectory: process.cwd(),
    });
    assert.equal(job.status, "running");
    first.close();
    first = undefined;

    second = new DurableJobManager(tempDir);
    const recovered = second.listJobs("restart_ws", 10);
    assert.equal(recovered.some((record) => record.id === job.id), true);

    let finalJob = second.getJob(job.id);
    for (let i = 0; i < 30; i++) {
      if (finalJob?.status !== "running") break;
      await delay(100);
      finalJob = second.getJob(job.id);
    }
    assert.equal(finalJob?.status, "succeeded");
    assert.match(second.readLogs(job.id).content, /restart-done/);
  } finally {
    first?.close();
    second?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Runtime environment normalization and LTS alias discovery", () => {
  const tempWs = mkdtempSync(join(tmpdir(), "devspace-env-test-"));
  const tempHome = mkdtempSync(join(tmpdir(), "devspace-home-test-"));
  const origHome = process.env.HOME;
  try {
    if (process.platform === "win32") {
      const env = resolveProjectEnvironment(tempWs);
      assert.equal(env.HOME, process.env.USERPROFILE || process.env.HOME || "");
      assert.ok((env.SHELL || "").toLowerCase().includes("cmd"));
      assert.equal(delimiter, ";");
      return;
    }

    // Setup mock NVM structure
    mkdirSync(join(tempHome, ".nvm/alias/lts"), { recursive: true });
    mkdirSync(join(tempHome, ".nvm/versions/node/v22.23.2/bin"), { recursive: true });
    mkdirSync(join(tempHome, ".nvm/versions/node/v20.18.0/bin"), { recursive: true });

    writeFileSync(join(tempHome, ".nvm/alias/lts/*"), "lts/customnamed\n", "utf8");
    writeFileSync(join(tempHome, ".nvm/alias/lts/customnamed"), "v20.18.0\n", "utf8");

    process.env.HOME = tempHome;

    // Test 1: Resolve dynamic alias through NVM metadata
    writeFileSync(join(tempWs, ".nvmrc"), "lts/*", "utf8");
    const env = resolveProjectEnvironment(tempWs);
    assert.ok(typeof env.PATH === "string");
    assert.ok(env.PATH.includes("v20.18.0"));

    // Test 2: Resolve named LTS alias
    writeFileSync(join(tempWs, ".nvmrc"), "lts/customnamed", "utf8");
    const envNamed = resolveProjectEnvironment(tempWs);
    assert.ok(envNamed.PATH?.includes("v20.18.0"));

    // Test 3: Standard version
    writeFileSync(join(tempWs, ".nvmrc"), "22", "utf8");
    const env22 = resolveProjectEnvironment(tempWs);
    assert.ok(env22.PATH?.includes("v22.23.2"));

    const diag = getRuntimeDiagnostics(tempWs);
    assert.ok(diag.nodeVersion);
    assert.ok(diag.gitVersion === null || typeof diag.gitVersion === "string");
    assert.ok(diag.shell);
  } finally {
    process.env.HOME = origHome;
    rmSync(tempWs, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});
