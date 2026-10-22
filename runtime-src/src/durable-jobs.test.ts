import test from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, utimesSync, writeFileSync, existsSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import childProcess, { spawn, spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { DurableJobManager, canUseSystemdUserJobIsolation, durableJobSystemdUnitName } from "./durable-jobs.js";
import { fileTimeToDotNetTicks, ownedProcessState, processStartIdentity, setProcessIdentityProviderForTests, waitForOwnedProcessExit } from "./process-platform.js";
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

test("launch INSERT failure starts nothing; post-launch persistence failure remains blocking until confirmed stopped", {
  skip: process.platform !== "linux",
}, async (t) => {
  const state = mkdtempSync(join(tmpdir(), "devspace-launch-order-"));
  const { DurableJobManager: LaunchManager } = await import(new URL("./durable-jobs.ts?launch-order", import.meta.url).href) as typeof import("./durable-jobs.js");
  const manager = new LaunchManager(state);
  const previousIsolation = process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS;
  delete process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS;
  const db = new Database(join(state, "jobs", "jobs.sqlite"));
  let launched = 0;
  let active = true;
  const original = childProcess.spawnSync;
  t.mock.method(childProcess, "spawnSync", ((file: string, args: string[]) => {
    if (file === "systemd-run" && !args.includes("--version")) {
      const row = db.prepare("SELECT status, error FROM durable_jobs").get() as {status: string; error: string};
      assert.equal(row.status, "pending", "row must exist before launch");
      assert.match(row.error, /Launch intent/);
      launched++;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (file === "systemd-run" || file === "systemctl") {
      if (args.includes("is-active")) return { status: active ? 0 : 3, stdout: active ? "active" : "inactive", stderr: "" };
      if (args.includes("MainPID")) return { status: 0, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    }
    return original(file, args);
  }) as typeof spawnSync);
  syncBuiltinESMExports();
  try {
    // The separately loaded module probes the mocked supervisor, not the real bus.
    db.exec("CREATE TRIGGER reject_insert BEFORE INSERT ON durable_jobs BEGIN SELECT RAISE(FAIL, 'synthetic insert failure'); END");
    assert.throws(() => manager.startJob({ workspaceId: "test", workspaceRoot: state,
      workingDirectory: state, command: "echo safe" }), /synthetic insert failure/);
    assert.equal(launched, 0);
    assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM durable_jobs").get(), { n: 0 });
    db.exec("DROP TRIGGER reject_insert");
    db.exec(`CREATE TRIGGER reject_running BEFORE UPDATE ON durable_jobs
      WHEN NEW.status = 'running' BEGIN SELECT RAISE(FAIL, 'synthetic update failure'); END`);
    const job = manager.startJob({ workspaceId: "test", workspaceRoot: state, workingDirectory: state, command: "echo safe" });
    assert.equal(job.status, "pending");
    assert.equal(launched, 1);
    assert.match(job.error ?? "", /cleanup unconfirmed/);
    assert.equal(manager.pruneCompleted(Number.MAX_SAFE_INTEGER), 0, "pending rows must never be pruned");
    manager.reconcile();
    assert.equal(manager.getJob(job.id)?.status, "pending");
    active = false;
    manager.reconcile();
    assert.equal(manager.getJob(job.id)?.status, "failed");
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    db.close(); manager.close(); rmSync(state, { recursive: true, force: true });
    if (previousIsolation === undefined) delete process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS;
    else process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS = previousIsolation;
  }
});

test("DurableJobManager: malformed and unknown handles never access metadata", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-job-handles-"));
  const mgr = new DurableJobManager(tempDir);
  const sibling = join(tempDir, "sibling.env.json");
  const unknown = "job_aaaaaaaaaaaaaaaa";
  const marker = join(tempDir, "jobs", "meta", `${unknown}.exit`);
  writeFileSync(sibling, "synthetic environment");
  writeFileSync(join(tempDir, "sibling.exit"), JSON.stringify({ exitCode: 0, endedAt: 1, signal: null }));
  writeFileSync(marker, JSON.stringify({ exitCode: 0, endedAt: 1, signal: null }));
  const accesses: unknown[] = [];
  try {
    for (const name of ["existsSync", "readFileSync", "unlinkSync"] as const) {
      t.mock.method(fs, name, (...args: unknown[]) => { accesses.push(args[0]); throw new Error("Unexpected metadata access"); });
    }
    syncBuiltinESMExports();
    for (const id of ["../../sibling", "..\\..\\sibling", "/sibling", "", "job_wrong", `${unknown}\n`, unknown]) {
      assert.equal(mgr.getJob(id), null);
      assert.equal(mgr.readLogs(id).content, "");
      assert.equal((await mgr.cancelJob(id)).success, false);
    }
    assert.deepEqual(accesses, []);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    const db = new Database(join(tempDir, "jobs", "jobs.sqlite"));
    try {
      db.prepare(`INSERT INTO durable_jobs
        (id, workspace_id, workspace_root, command, working_directory, status, log_path,
         created_at, last_heartbeat, max_runtime_seconds)
        VALUES (?, 'test', ?, 'echo safe', ?, 'running', ?, 1, 1, 60)`)
        .run(unknown, tempDir, tempDir, join(tempDir, "jobs", "logs", `${unknown}.log`));
      const launchSpec = join(tempDir, "jobs", "meta", `${unknown}.env.json`);
      writeFileSync(launchSpec, "synthetic environment");
      assert.equal(mgr.getJob(unknown)?.status, "succeeded");
      assert.equal(existsSync(launchSpec), false, "an existing row may consume its own completion metadata");
    } finally { db.close(); }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(readFileSync(sibling, "utf8"), "synthetic environment");
    mgr.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: starts, tracks, and reads logs from detached job", {
  skip: process.platform === "linux" && !canUseSystemdUserJobIsolation() ? "Linux user-systemd unavailable" : false,
}, async () => {
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

test("DurableJobManager: preserves explicit environment through the job supervisor", {
  skip: process.platform === "linux" && !canUseSystemdUserJobIsolation() ? "Linux user-systemd unavailable" : false,
}, async () => {
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
    assert.equal((await mgr.cancelJob(job.id)).success, true);
    jobId = "";
  } finally {
    if (jobId && mgr.getJob(jobId)?.status === "running") await mgr.cancelJob(jobId);
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
    if (jobId && manager?.getJob(jobId)?.status === "running") await manager.cancelJob(jobId);
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
    if (jobId && manager?.getJob(jobId)?.status === "running") await manager.cancelJob(jobId);
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
  skip: !canUseSystemdUserJobIsolation(),
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
    "  *is-active*) if [ \"$FAKE_UNIT_ACTIVE\" = 1 ]; then exit 0; elif [ \"$FAKE_UNIT_ACTIVE\" = unknown ]; then exit 1; else echo inactive; exit 3; fi ;;",
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
    assert.equal(job.status, "pending", "an unconfirmed launch must block rollback");
    assert.match(job.error ?? "", /cleanup unconfirmed/);
    assert.equal(readdirSync(join(tempDir, "jobs", "meta")).filter(name => name.endsWith(".env.json")).length, 1);
    process.env.FAKE_UNIT_ACTIVE = "unknown";
    mgr.reconcile();
    assert.equal(mgr.getJob(job.id)?.status, "pending", "a failed status query must not clear a possibly active unit");
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
}, async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "devspace-jobs-stop-unknown-test-"));
  const previousIsolation = process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS;
  delete process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS;
  let active = "1";
  const originalSpawn = childProcess.spawnSync;
  t.mock.method(childProcess, "spawnSync", ((file: string, args: string[]) => {
    if (file === "systemd-run") return { status: 0, stdout: "", stderr: "" };
    if (file === "systemctl") {
      if (args.includes("show-environment")) return { status: 0, stdout: "", stderr: "" };
      if (args.includes("stop")) return { status: 1, stdout: "", stderr: "" };
      if (args.includes("is-active")) return active === "1" ? { status: 0, stdout: "active" } :
        active === "stopping" ? { status: 3, stdout: "deactivating" } :
        active === "unknown" ? { status: 1, stdout: "" } : { status: 3, stdout: "inactive" };
      throw new Error("Unexpected systemctl command");
    }
    return originalSpawn(file, args);
  }) as typeof spawnSync);
  syncBuiltinESMExports();
  const { DurableJobManager: StopManager } = await import(new URL("./durable-jobs.ts?stop-unknown", import.meta.url).href) as typeof import("./durable-jobs.js");
  const mgr = new StopManager(tempDir);
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
    active = "1";
    const cancellation = await mgr.cancelJob(ids.cancel);
    assert.equal(cancellation.success, false, "failed stop must not claim cancellation");
    assert.equal(mgr.getJob(ids.cancel)?.status, "running");
    mgr.reconcile();
    assert.equal(mgr.getJob(ids.timeout)?.status, "running", "timeout alone is not proof of exit");
    assert.match(mgr.getJob(ids.timeout)?.error ?? "", /maxRuntimeSeconds/);
    active = "stopping";
    mgr.reconcile();
    assert.equal(mgr.getJob(ids.cancel)?.status, "running", "deactivating is not a confirmed exit");
    active = "unknown";
    mgr.reconcile();
    assert.equal(mgr.getJob(ids.cancel)?.status, "running", "unknown unit state remains blocking");
    assert.equal(mgr.getJob(ids.timeout)?.status, "running");
    // A late success marker must not turn an already-timed-out job into success.
    writeFileSync(join(tempDir, "jobs", "meta", `${ids.marker}.exit`),
      JSON.stringify({ exitCode: 0, signal: null, endedAt: now }));
    assert.equal(mgr.getJob(ids.marker)?.status, "failed");
    active = "0";
    mgr.reconcile();
    assert.equal(mgr.getJob(ids.cancel)?.status, "cancelled");
    assert.equal(mgr.getJob(ids.timeout)?.status, "failed");
    assert.match(mgr.getJob(ids.timeout)?.error ?? "", /maxRuntimeSeconds/);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    db.close(); mgr.close();
    if (previousIsolation === undefined) delete process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS;
    else process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS = previousIsolation;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: cancels running job and updates record", {
  skip: process.platform === "linux" && !canUseSystemdUserJobIsolation() ? "Linux user-systemd unavailable" : false,
}, async () => {
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
    const cancelRes = await mgr.cancelJob(job.id);
    assert.equal(cancelRes.success, true);

    const postCancel = mgr.getJob(job.id);
    assert.equal(postCancel?.status, "cancelled");
  } finally {
    mgr.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: reconnect preserves job handle and confirms cancellation", {
  skip: process.platform === "linux" && !canUseSystemdUserJobIsolation() ? "Linux user-systemd unavailable" : false,
}, async () => {
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
    await second.cancelJob(jobId);
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
    if (jobId && second?.getJob(jobId)?.status === "running") await second.cancelJob(jobId);
    first?.close();
    second?.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DurableJobManager: log pagination with maxLines preserves nextOffset", {
  skip: process.platform === "linux" && !canUseSystemdUserJobIsolation() ? "Linux user-systemd unavailable" : false,
}, async () => {
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

test("DurableJobManager: prunes completed jobs after retention", {
  skip: process.platform === "linux" && !canUseSystemdUserJobIsolation() ? "Linux user-systemd unavailable" : false,
}, async () => {
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

test("DurableJobManager: reconciles a detached job after manager restart", {
  skip: process.platform === "linux" && !canUseSystemdUserJobIsolation() ? "Linux user-systemd unavailable" : false,
}, async () => {
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

for (const mode of ["timeout", "success", "cancel"] as const) {
  test(`runner owns ${mode} terminal persistence without a Runtime manager`, async () => {
    const state = mkdtempSync(join(tmpdir(), "devspace-runner-owner-"));
    const dbPath = join(state, "jobs.sqlite");
    const db = new Database(dbPath);
    const id = "job_eeeeeeeeeeeeeeee";
    const marker = join(state, `${id}.exit`);
    const runner = fileURLToPath(new URL("./durable-job-runner.ts", import.meta.url));
    const node = process.platform === "win32" ? `"${process.execPath}"` : JSON.stringify(process.execPath);
    const command = mode === "timeout" ? `${node} -e "setInterval(()=>{},100)"` :
      `${node} -e "setTimeout(()=>process.exit(0),500)"`;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      db.pragma("journal_mode = WAL");
      db.exec(`CREATE TABLE durable_jobs (id TEXT PRIMARY KEY, status TEXT, error TEXT,
        created_at INTEGER, started_at INTEGER, max_runtime_seconds REAL, pid INTEGER, process_identity TEXT,
        exit_code INTEGER, signal TEXT, ended_at INTEGER, last_heartbeat INTEGER)`);
      db.prepare("INSERT INTO durable_jobs (id,status,created_at,max_runtime_seconds) VALUES (?, 'pending', ?, ?)")
        .run(id, Math.floor(Date.now() / 1000), mode === "timeout" ? 2 : 30);
      child = spawn(process.execPath, ["--import", "tsx", runner, marker, command, "", dbPath, id],
        { cwd: process.cwd(), stdio: "ignore", windowsHide: true });
      const closed = new Promise<void>((resolve, reject) => { child!.once("close", () => resolve()); child!.once("error", reject); });
      if (mode === "cancel") {
        for (let i = 0; i < 100; i++) {
          const row = db.prepare("SELECT status FROM durable_jobs").get() as {status: string};
          if (row.status === "running") break;
          await delay(20);
        }
        // Simulate cancellation arriving just as a successful command exits.
        db.prepare("UPDATE durable_jobs SET error = 'Cancellation requested; process exit not yet confirmed'").run();
      }
      await closed;
      const row = db.prepare("SELECT * FROM durable_jobs").get() as {status: string; error: string; pid: number; process_identity: string; ended_at: number};
      assert.equal(row.status, mode === "timeout" ? "failed" : mode === "cancel" ? "cancelled" : "succeeded");
      assert.ok(row.ended_at);
      assert.ok(row.process_identity, "runner must persist its own start identity");
      if (mode === "timeout") assert.match(row.error, /maxRuntimeSeconds/);
      assert.ok(existsSync(marker), "completion marker remains available for recovery");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      db.close(); rmSync(state, { recursive: true, force: true });
    }
  });
}

test("a recycled PID is not owned, cannot keep an inactive Linux unit alive, and is never signalled", {
  skip: process.platform !== "linux",
}, async (t) => {
  const state = mkdtempSync(join(tmpdir(), "devspace-pid-reuse-"));
  const manager = new DurableJobManager(state);
  const db = new Database(join(state, "jobs", "jobs.sqlite"));
  const id = "job_dddddddddddddddd";
  const realKill = process.kill;
  const signals: unknown[] = [];
  const original = childProcess.spawnSync;
  t.mock.method(childProcess, "spawnSync", ((file: string, args: string[]) => file === "systemctl"
    ? { status: args.includes("is-active") ? 3 : 1, stdout: "inactive", stderr: "" } : original(file, args)) as typeof spawnSync);
  t.mock.method(process, "kill", ((pid: number, signal: NodeJS.Signals | number) => {
    if (signal !== 0) { signals.push([pid, signal]); return true; }
    return realKill(pid, signal);
  }) as typeof process.kill);
  syncBuiltinESMExports();
  try {
    assert.ok(processStartIdentity(process.pid));
    assert.equal(ownedProcessState(process.pid, "linux:synthetic-mismatch"), "inactive");
    assert.equal(ownedProcessState(process.pid, null), "unknown");
    db.prepare(`INSERT INTO durable_jobs (id,workspace_id,workspace_root,command,working_directory,
      pid,process_identity,status,log_path,created_at,last_heartbeat,max_runtime_seconds)
      VALUES (?, 'test', ?, 'echo safe', ?, ?, 'linux:synthetic-mismatch', 'running', ?, ?, ?, 60)`)
      .run(id, state, state, process.pid, join(state, "log"), Math.floor(Date.now()/1000), Math.floor(Date.now()/1000));
    assert.equal((await manager.cancelJob(id)).record?.status, "cancelled");
    assert.deepEqual(signals, []);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    db.close(); manager.close(); rmSync(state, {recursive: true, force: true});
  }
});

test("terminal publication preserves persisted cancel/timeout intent against late success", async () => {
  const { publishJobCompletion, CANCELLATION_PENDING, TIMEOUT_REASON } = await import("./durable-jobs.js");
  const state = mkdtempSync(join(tmpdir(), "devspace-terminal-intent-"));
  const manager = new DurableJobManager(state);
  const db = new Database(join(state, "jobs", "jobs.sqlite"));
  const id = "job_ffffffffffffffff";
  try {
    db.prepare(`INSERT INTO durable_jobs (id,workspace_id,workspace_root,command,working_directory,
      status,log_path,created_at,last_heartbeat,max_runtime_seconds)
      VALUES (?, 'test', ?, 'echo safe', ?, 'running', ?, 1, 1, 60)`)
      .run(id, state, state, join(state, "log"));
    for (const status of ["pending", "running", "cancelling"]) {
      for (const error of [null, CANCELLATION_PENDING, TIMEOUT_REASON]) {
        db.prepare("UPDATE durable_jobs SET status = ?, error = ? WHERE id = ?").run(status, error, id);
        publishJobCompletion(db, id, 0, null, 10);
        const row = db.prepare("SELECT status FROM durable_jobs WHERE id = ?").get(id) as {status: string};
        assert.equal(row.status, status === "cancelling" || error === CANCELLATION_PENDING ? "cancelled" :
          error === TIMEOUT_REASON ? "failed" : "succeeded");
        publishJobCompletion(db, id, 1, "SIGKILL", 20);
        assert.deepEqual(db.prepare("SELECT status, ended_at FROM durable_jobs WHERE id = ?").get(id),
          { status: row.status, ended_at: 10 }, "terminal rows must not be overwritten");
      }
    }
  } finally { db.close(); manager.close(); rmSync(state, { recursive: true, force: true }); }
});

test("Windows fallback never signals a recycled or unidentifiable PID", async (t) => {
  const state = mkdtempSync(join(tmpdir(), "devspace-windows-identity-"));
  const manager = new DurableJobManager(state);
  const db = new Database(join(state, "jobs", "jobs.sqlite"));
  const id = "job_aaaaaaaaaaaaaaab";
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const calls: string[] = [];
  const original = childProcess.spawnSync;
  let stopped = false;
  setProcessIdentityProviderForTests((pid) => (pid === 1234 ? stopped ? "windows:reused" : "windows:12345" : null));
  t.mock.method(childProcess, "spawnSync", ((file: string, args: string[]) => {
    if (file === "powershell.exe") return { status: 0, stdout: "12345\n", stderr: "" };
    if (file === "taskkill.exe") { stopped = true; calls.push("taskkill"); return { status: 0, stdout: "", stderr: "" }; }
    return original(file, args);
  }) as typeof spawnSync);
  t.mock.method(process, "kill", ((_pid: number, signal: NodeJS.Signals | number) => {
    if (signal !== 0) calls.push("signal");
    return true;
  }) as typeof process.kill);
  syncBuiltinESMExports();
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO durable_jobs (id,workspace_id,workspace_root,command,working_directory,
      pid,process_identity,status,log_path,created_at,last_heartbeat,max_runtime_seconds)
      VALUES (?, 'test', ?, 'echo safe', ?, 1234, 'windows:other-creation-time', 'running', ?, ?, ?, 60)`)
      .run(id, state, state, join(state, "log"), now, now);
    assert.equal((await manager.cancelJob(id)).record?.status, "cancelled");
    assert.deepEqual(calls, [], "mismatched identity must never reach taskkill or kill");
    db.prepare("UPDATE durable_jobs SET status = 'running', process_identity = NULL, error = NULL").run();
    assert.equal((await manager.cancelJob(id)).success, false);
    assert.equal(manager.getJob(id)?.status, "running", "unidentifiable live PID remains blocking");
    assert.deepEqual(calls, [], "unknown identity permits existence probes only");
    db.prepare("UPDATE durable_jobs SET status = 'running', process_identity = 'windows:12345', error = NULL").run();
    await manager.cancelJob(id);
    assert.deepEqual(calls, ["taskkill"], "matching identity on win32 routes to taskkill");
  } finally {
    setProcessIdentityProviderForTests(null);
    Object.defineProperty(process, "platform", platform);
    t.mock.restoreAll(); syncBuiltinESMExports();
    db.close(); manager.close(); rmSync(state, { recursive: true, force: true });
  }
});

test("fileTimeToDotNetTicks converts Windows FILETIME to .NET ticks", () => {
  assert.equal(fileTimeToDotNetTicks(0n), "504911232000000000");

  const ms = BigInt(Date.UTC(2026, 0, 1));
  const fileTime = ms * 10000n + 116444736000000000n;
  const dotNetTicks = ms * 10000n + 621355968000000000n;
  assert.equal(fileTimeToDotNetTicks(fileTime), dotNetTicks.toString());
});

test("processStartIdentity returns stable windows:<ticks> matching PowerShell on win32", {
  skip: process.platform !== "win32",
}, () => {
  const first = processStartIdentity(process.pid);
  assert.ok(first, "processStartIdentity(process.pid) must be non-null");
  assert.match(first, /^windows:\d+$/);

  const second = processStartIdentity(process.pid);
  assert.equal(second, first, "processStartIdentity must be stable across calls");

  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$ErrorActionPreference='Stop'; (Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks.ToString()`,
  // Reference value only: a cold PowerShell start on CI runners can exceed 5 s.
  ], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(result.status, 0, `PowerShell command failed: ${result.stderr}`);
  const ticks = result.stdout?.trim();
  assert.ok(ticks && /^\d+$/.test(ticks), `Expected numeric ticks from PowerShell, got: ${ticks}`);
  assert.equal(first, `windows:${ticks}`);
});

test("waitForOwnedProcessExit confirms exit for short-lived and killed processes, honours custom provider", async () => {
  const shortChild = spawn(process.execPath, ["-e", "setTimeout(()=>{},200)"], { stdio: "ignore" });
  const shortPid = shortChild.pid!;
  assert.ok(shortPid);
  const shortIdentity = processStartIdentity(shortPid);
  const shortExited = await waitForOwnedProcessExit(shortPid, shortIdentity, 3000);
  assert.equal(shortExited, true);

  const longChild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const longPid = longChild.pid!;
  assert.ok(longPid);
  const longIdentity = processStartIdentity(longPid);
  try {
    longChild.kill("SIGKILL");
    const longExited = await waitForOwnedProcessExit(longPid, longIdentity, 3000);
    assert.equal(longExited, true);
  } finally {
    try { longChild.kill("SIGKILL"); } catch {}
  }

  let providerCalls = 0;
  const syntheticPid = 8888888;
  setProcessIdentityProviderForTests((pid) => {
    if (pid === syntheticPid) {
      providerCalls++;
      return providerCalls > 2 ? null : "mock-identity";
    }
    return processStartIdentity(pid);
  });
  try {
    const pollResult = await waitForOwnedProcessExit(syntheticPid, "mock-identity", 1000);
    assert.equal(pollResult, true);
    assert.ok(providerCalls > 2, "poll path must query the custom identity provider");
  } finally {
    setProcessIdentityProviderForTests(null);
  }
});

test("POSIX image FIFO is rejected without waiting for a writer", { skip: process.platform === "win32" }, () => {
  const state = mkdtempSync(join(tmpdir(), "devspace-image-fifo-"));
  try {
    const fifo = join(state, "image.png");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    const module = new URL("./image-read.ts", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `import { readImageFile } from ${JSON.stringify(module)};\nawait readImageFile(process.argv[1]).then(() => process.exit(2), e => { if (!/not a regular file/.test(e.message)) throw e; });`, fifo],
      { encoding: "utf8", timeout: 1500 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test("switch gate recovers only a confirmed dead owner and rejects an abandoned late runner", async () => {
  const state = mkdtempSync(join(tmpdir(), "devspace-dead-gate-"));
  const manager = new DurableJobManager(state);
  const db = new Database(join(state, "jobs", "jobs.sqlite"));
  const id = "job_abcabcabcabcabca";
  const gate = join(state, ".runtime-switch-gate");
  try {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO durable_jobs (id,workspace_id,workspace_root,command,working_directory,
      status,error,log_path,created_at,last_heartbeat,max_runtime_seconds)
      VALUES (?, 'test', ?, 'echo must-not-run', ?, 'pending',
      'Launch intent persisted; runner start not yet confirmed', ?, ?, ?, 60)`)
      .run(id, state, state, join(state, "log"), now, now);
    mkdirSync(gate);
    writeFileSync(join(gate, "owner.json"), JSON.stringify({ pid: process.pid, processStartIdentity: "owner:1", createdAt: Date.now() }));
    setProcessIdentityProviderForTests(() => "owner:1");
    manager.reconcile();
    assert.equal(manager.getJob(id)?.status, "pending", "live starter retains ownership");
    setProcessIdentityProviderForTests(() => null);
    manager.reconcile();
    assert.equal(existsSync(gate), true, "unknown owner remains blocking");
    assert.equal(manager.getJob(id)?.status, "pending");
    setProcessIdentityProviderForTests(() => "owner:reused");
    manager.reconcile();
    assert.equal(existsSync(gate), false);
    assert.equal(manager.getJob(id)?.status, "failed");
    const marker = join(state, "jobs", "meta", `${id}.exit`);
    const runner = fileURLToPath(new URL("./durable-job-runner.ts", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", runner, marker, "echo must-not-run", "", join(state, "jobs", "jobs.sqlite"), id],
      { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(marker), false);
    assert.equal(manager.getJob(id)?.status, "failed");
  } finally {
    setProcessIdentityProviderForTests(null);
    db.close(); manager.close(); rmSync(state, { recursive: true, force: true });
  }
});

test("runner cannot execute after losing its guarded launch claim", async () => {
  const state = mkdtempSync(join(tmpdir(), "devspace-runner-claim-"));
  const manager = new DurableJobManager(state);
  const db = new Database(join(state, "jobs", "jobs.sqlite"));
  const id = "job_abcabcabcabcabcb";
  try {
    db.prepare(`INSERT INTO durable_jobs (id,workspace_id,workspace_root,command,working_directory,
      status,error,log_path,created_at,last_heartbeat,max_runtime_seconds)
      VALUES (?, 'test', ?, 'echo must-not-run', ?, 'pending',
      'Launch intent persisted; runner start not yet confirmed', ?, ?, ?, 60)`)
      .run(id, state, state, join(state, "log"), Math.floor(Date.now()/1000), Math.floor(Date.now()/1000));
    // Force the claim to lose after the runner's initial SELECT.
    db.exec(`CREATE TRIGGER lose_claim BEFORE UPDATE ON durable_jobs WHEN NEW.status = 'running'
      BEGIN SELECT RAISE(IGNORE); END`);
    const runner = fileURLToPath(new URL("./durable-job-runner.ts", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", runner, join(state, "marker"), "echo must-not-run", "", join(state, "jobs", "jobs.sqlite"), id],
      { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(join(state, "marker")), false, "losing runner must not publish completion");
    assert.equal(manager.getJob(id)?.status, "pending");
    db.exec(`DROP TRIGGER lose_claim;
      CREATE TRIGGER cancel_claim BEFORE UPDATE ON durable_jobs WHEN NEW.status = 'running'
      BEGIN UPDATE durable_jobs SET error = 'Cancellation requested; process exit not yet confirmed' WHERE id = NEW.id;
      SELECT RAISE(IGNORE); END`);
    const cancelled = spawnSync(process.execPath, ["--import", "tsx", runner, join(state, "marker"), "echo must-not-run", "", join(state, "jobs", "jobs.sqlite"), id],
      { encoding: "utf8", timeout: 5000 });
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal(cancelled.stdout, "");
    assert.equal(manager.getJob(id)?.status, "cancelled", "a cancel that wins the claim race still completes without a PID");
  } finally { db.close(); manager.close(); rmSync(state, { recursive: true, force: true }); }
});

test("cancel losing the intent race returns terminal truth without signalling", async (t) => {
  const state = mkdtempSync(join(tmpdir(), "devspace-cancel-race-"));
  const manager = new DurableJobManager(state);
  const db = new Database(join(state, "jobs", "jobs.sqlite"));
  const id = "job_abcabcabcabcabcc";
  try {
    const now = Math.floor(Date.now()/1000);
    db.prepare(`INSERT INTO durable_jobs (id,workspace_id,workspace_root,command,working_directory,
      pid,process_identity,status,log_path,created_at,last_heartbeat,max_runtime_seconds)
      VALUES (?, 'test', ?, 'echo safe', ?, ?, ?, 'running', ?, ?, ?, 60)`)
      .run(id, state, state, process.pid, processStartIdentity(process.pid), join(state, "log"), now, now);
    const get = manager.getJob.bind(manager);
    t.mock.method(manager, "getJob", (jobId: string) => {
      const snapshot = get(jobId);
      db.prepare("UPDATE durable_jobs SET status = 'succeeded', exit_code = 0 WHERE id = ?").run(id);
      return snapshot;
    });
    const realKill = process.kill;
    t.mock.method(process, "kill", ((pid: number, signal: NodeJS.Signals | number) => {
      assert.equal(signal, 0, "a lost cancellation must not signal");
      return realKill(pid, signal);
    }) as typeof process.kill);
    const result = await manager.cancelJob(id);
    assert.equal(result.success, false);
    assert.equal(result.message, "already succeeded");
    assert.equal(result.record?.status, "succeeded");
  } finally { t.mock.restoreAll(); db.close(); manager.close(); rmSync(state, { recursive: true, force: true }); }
});

test("POSIX cancellation forwards to command group and waits without blocking timers", { skip: process.platform === "win32" }, async () => {
  const state = mkdtempSync(join(tmpdir(), "devspace-posix-stop-"));
  const previous = process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS;
  process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS = "1";
  const manager = new DurableJobManager(state);
  const db = new Database(join(state, "jobs", "jobs.sqlite"));
  const id = "job_abcabcabcabcabcd";
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const now = Math.floor(Date.now()/1000);
    const pidPath = join(state, "command.pid");
    const command = `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync(${JSON.stringify(pidPath)},String(process.pid)); setInterval(()=>{},100)'`;
    db.prepare(`INSERT INTO durable_jobs (id,workspace_id,workspace_root,command,working_directory,
      status,log_path,created_at,last_heartbeat,max_runtime_seconds)
      VALUES (?, 'test', ?, ?, ?, 'pending', ?, ?, ?, 60)`)
      .run(id, state, command, state, join(state, "log"), now, now);
    const runner = fileURLToPath(new URL("./durable-job-runner.ts", import.meta.url));
    child = spawn(process.execPath, ["--import", "tsx", runner, join(state, "jobs", "meta", `${id}.exit`), command, "", join(state, "jobs", "jobs.sqlite"), id], { stdio: "ignore", detached: true });
    for (let i=0; i<100 && !existsSync(pidPath); i++) await delay(20);
    assert.ok(existsSync(pidPath));
    const pid = Number(readFileSync(pidPath, "utf8"));
    const identity = processStartIdentity(pid);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    let result;
    try { result = await manager.cancelJob(id); } finally { clearInterval(timer); }
    assert.equal(result.success, true);
    assert.equal(result.record?.status, "cancelled");
    assert.equal(ownedProcessState(pid, identity), "inactive", "command must stop before cancellation is confirmed");
    assert.ok(ticks > 0, "cancellation must let event-loop timers run");
    const marker = JSON.parse(readFileSync(join(state, "jobs", "meta", `${id}.exit`), "utf8"));
    assert.equal(marker.signal, "SIGKILL", "runner must retain the actual command termination signal");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    db.close(); manager.close(); rmSync(state, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS;
    else process.env.DEVSPACE_DISABLE_SYSTEMD_DURABLE_JOBS = previous;
  }
});

for (const code of [0, 7]) {
  test(`runner preserves actual exit ${code} marker when DB publication fails and reconciliation recovers it`, async () => {
    const state = mkdtempSync(join(tmpdir(), "devspace-marker-first-"));
    const manager = new DurableJobManager(state);
    const db = new Database(join(state, "jobs", "jobs.sqlite"));
    const id = "job_abcabcabcabcabce";
    try {
      const now = Math.floor(Date.now()/1000);
      db.prepare(`INSERT INTO durable_jobs (id,workspace_id,workspace_root,command,working_directory,
        status,log_path,created_at,last_heartbeat,max_runtime_seconds)
        VALUES (?, 'test', ?, 'exit', ?, 'pending', ?, ?, ?, 60)`)
        .run(id, state, state, join(state, "log"), now, now);
      db.exec(`CREATE TRIGGER reject_completion BEFORE UPDATE ON durable_jobs
        WHEN NEW.status IN ('succeeded', 'failed', 'cancelled') BEGIN SELECT RAISE(FAIL, 'synthetic publication failure'); END`);
      const runner = fileURLToPath(new URL("./durable-job-runner.ts", import.meta.url));
      const marker = join(state, "jobs", "meta", `${id}.exit`);
      const result = spawnSync(process.execPath, ["--import", "tsx", runner, marker, `exit ${code}`, "", join(state, "jobs", "jobs.sqlite"), id],
        { encoding: "utf8", timeout: 5000 });
      assert.match(result.stderr, /synthetic publication failure/);
      assert.equal(JSON.parse(readFileSync(marker, "utf8")).exitCode, code);
      assert.equal((db.prepare("SELECT status FROM durable_jobs").get() as {status: string}).status, "running");
      db.exec("DROP TRIGGER reject_completion");
      manager.reconcile();
      assert.equal(manager.getJob(id)?.status, code === 0 ? "succeeded" : "failed");
      assert.equal(manager.getJob(id)?.exitCode, code);
    } finally { db.close(); manager.close(); rmSync(state, { recursive: true, force: true }); }
  });
}
