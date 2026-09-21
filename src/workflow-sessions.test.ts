import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Workspace } from "./workspaces.js";
import { WorkflowSessionManager } from "./workflow-sessions.js";

const workspace: Workspace = {
  id: "ws_initial",
  root: "/tmp/worktree",
  canonicalRoot: "/tmp/worktree",
  mode: "worktree",
  sourceRoot: "/tmp/repo",
  worktree: {
    path: "/tmp/worktree",
    baseRef: "main",
    baseSha: "abc123",
    dirtySource: false,
    detached: true,
    managed: true,
  },
  skills: [],
  skillDiagnostics: [],
  agentProfiles: [],
};

test("workflow sessions persist bounded task, validation, review and handoff evidence", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workflow-test-"));
  const manager = new WorkflowSessionManager(stateDir);
  t.after(async () => {
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const started = manager.start(workspace, "Ship reconnect-safe workflow evidence.");
  assert.equal(started.status, "active");
  assert.equal(started.workspaceRoot, workspace.canonicalRoot);
  assert.equal(started.baseSha, "abc123");
  assert.equal(started.managedWorktree, true);

  const recorded = manager.record({
    id: started.id,
    workspaceRoot: workspace.canonicalRoot,
    validation: {
      status: "pass",
      summary: "typecheck and targeted tests passed",
      runId: "run_123",
    },
    reviewRef: "refs/devspace/review/abc",
  });
  assert.equal(recorded.validation.length, 1);
  assert.equal(recorded.validation[0]?.runId, "run_123");
  assert.equal(recorded.reviewRef, "refs/devspace/review/abc");

  const finished = manager.finish({
    id: started.id,
    workspaceRoot: workspace.canonicalRoot,
    handoffSummary: "Implementation and validation evidence are recorded.",
  });
  assert.equal(finished.status, "completed");
  assert.ok(finished.completedAt);
  assert.equal(manager.list(workspace.canonicalRoot)[0]?.id, started.id);
});

test("workflow IDs are not authority across canonical workspace roots", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workflow-test-"));
  const manager = new WorkflowSessionManager(stateDir);
  t.after(async () => {
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const started = manager.start(workspace, "Scope workflow evidence to its workspace.");
  assert.equal(manager.get(started.id, "/tmp/other"), undefined);
  assert.throws(
    () => manager.record({
      id: started.id,
      workspaceRoot: "/tmp/other",
      handoffSummary: "must not update",
    }),
    /not found for this workspace/,
  );
});

test("workflow validation evidence remains bounded to the latest 50 entries", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workflow-test-"));
  const manager = new WorkflowSessionManager(stateDir);
  t.after(async () => {
    manager.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const started = manager.start(workspace, "Bound workflow evidence.");
  for (let index = 0; index < 55; index += 1) {
    manager.record({
      id: started.id,
      workspaceRoot: workspace.canonicalRoot,
      validation: {
        status: "info",
        summary: `evidence-${index}`,
      },
    });
  }
  const current = manager.get(started.id, workspace.canonicalRoot);
  assert.equal(current?.validation.length, 50);
  assert.equal(current?.validation[0]?.summary, "evidence-5");
  assert.equal(current?.validation.at(-1)?.summary, "evidence-54");
});
