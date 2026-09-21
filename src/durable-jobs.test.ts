import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DurableJobManager } from "./durable-jobs.js";
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
