import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "./db/client.js";
import type { Workspace } from "./workspaces.js";

export type WorkflowSessionStatus = "active" | "completed";
export type WorkflowValidationStatus = "pass" | "fail" | "info";

export interface WorkflowValidationEvidence {
  status: WorkflowValidationStatus;
  summary: string;
  runId?: string;
  recordedAt: string;
}

export interface WorkflowSessionRecord {
  id: string;
  workspaceSessionId: string;
  workspaceRoot: string;
  workspaceMode: Workspace["mode"];
  sourceRoot?: string;
  baseRef?: string;
  baseSha?: string;
  managedWorktree: boolean;
  taskIntent: string;
  status: WorkflowSessionStatus;
  validation: WorkflowValidationEvidence[];
  reviewRef?: string;
  handoffSummary?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface WorkflowRow {
  id: string;
  workspace_session_id: string;
  workspace_root: string;
  workspace_mode: string;
  source_root: string | null;
  base_ref: string | null;
  base_sha: string | null;
  managed_worktree: string;
  task_intent: string;
  status: string;
  validation_json: string;
  review_ref: string | null;
  handoff_summary: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const MAX_TASK_INTENT_CHARS = 2_000;
const MAX_HANDOFF_CHARS = 4_000;
const MAX_VALIDATION_SUMMARY_CHARS = 1_000;
const MAX_VALIDATION_ENTRIES = 50;
const MAX_REVIEW_REF_CHARS = 512;

export class WorkflowSessionManager {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  close(): void {
    this.database.close();
  }

  start(workspace: Workspace, taskIntent: string): WorkflowSessionRecord {
    const now = new Date().toISOString();
    const id = `wf_${randomUUID()}`;
    const intent = boundedRequired(taskIntent, MAX_TASK_INTENT_CHARS, "task_intent");
    this.database.sqlite.prepare(`
      insert into workflow_sessions (
        id, workspace_session_id, workspace_root, workspace_mode,
        source_root, base_ref, base_sha, managed_worktree,
        task_intent, status, validation_json, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '[]', ?, ?)
    `).run(
      id,
      workspace.id,
      workspace.canonicalRoot,
      workspace.mode,
      workspace.sourceRoot ?? null,
      workspace.worktree?.baseRef ?? null,
      workspace.worktree?.baseSha ?? null,
      workspace.worktree?.managed ? "true" : "false",
      intent,
      now,
      now,
    );
    return this.require(id);
  }

  get(id: string, workspaceRoot: string): WorkflowSessionRecord | undefined {
    const row = this.database.sqlite
      .prepare("select * from workflow_sessions where id = ? and workspace_root = ?")
      .get(id, workspaceRoot) as WorkflowRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(workspaceRoot: string, limit = 20): WorkflowSessionRecord[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.database.sqlite
      .prepare(
        "select * from workflow_sessions where workspace_root = ? order by updated_at desc limit ?",
      )
      .all(workspaceRoot, boundedLimit) as WorkflowRow[];
    return rows.map(fromRow);
  }

  record(input: {
    id: string;
    workspaceRoot: string;
    validation?: {
      status: WorkflowValidationStatus;
      summary: string;
      runId?: string;
    };
    reviewRef?: string;
    handoffSummary?: string;
  }): WorkflowSessionRecord {
    const existing = this.get(input.id, input.workspaceRoot);
    if (!existing) throw new Error(`Workflow session not found for this workspace: ${input.id}`);
    if (existing.status !== "active") {
      throw new Error(`Workflow session is already completed: ${input.id}`);
    }

    const validation = existing.validation.slice();
    if (input.validation) {
      validation.push({
        status: input.validation.status,
        summary: boundedRequired(
          input.validation.summary,
          MAX_VALIDATION_SUMMARY_CHARS,
          "validation.summary",
        ),
        ...(input.validation.runId
          ? { runId: boundedRequired(input.validation.runId, 256, "validation.run_id") }
          : {}),
        recordedAt: new Date().toISOString(),
      });
      if (validation.length > MAX_VALIDATION_ENTRIES) {
        validation.splice(0, validation.length - MAX_VALIDATION_ENTRIES);
      }
    }

    const reviewRef = input.reviewRef === undefined
      ? existing.reviewRef
      : boundedOptional(input.reviewRef, MAX_REVIEW_REF_CHARS);
    const handoffSummary = input.handoffSummary === undefined
      ? existing.handoffSummary
      : boundedOptional(input.handoffSummary, MAX_HANDOFF_CHARS);
    const updatedAt = new Date().toISOString();
    this.database.sqlite.prepare(`
      update workflow_sessions
      set validation_json = ?, review_ref = ?, handoff_summary = ?, updated_at = ?
      where id = ? and workspace_root = ?
    `).run(
      JSON.stringify(validation),
      reviewRef ?? null,
      handoffSummary ?? null,
      updatedAt,
      input.id,
      input.workspaceRoot,
    );
    return this.require(input.id);
  }

  finish(input: {
    id: string;
    workspaceRoot: string;
    handoffSummary: string;
    reviewRef?: string;
  }): WorkflowSessionRecord {
    const existing = this.get(input.id, input.workspaceRoot);
    if (!existing) throw new Error(`Workflow session not found for this workspace: ${input.id}`);
    if (existing.status === "completed") return existing;
    const handoff = boundedRequired(input.handoffSummary, MAX_HANDOFF_CHARS, "handoff_summary");
    const reviewRef = input.reviewRef === undefined
      ? existing.reviewRef
      : boundedOptional(input.reviewRef, MAX_REVIEW_REF_CHARS);
    const now = new Date().toISOString();
    this.database.sqlite.prepare(`
      update workflow_sessions
      set status = 'completed', handoff_summary = ?, review_ref = ?,
          updated_at = ?, completed_at = ?
      where id = ? and workspace_root = ?
    `).run(
      handoff,
      reviewRef ?? null,
      now,
      now,
      input.id,
      input.workspaceRoot,
    );
    return this.require(input.id);
  }

  private require(id: string): WorkflowSessionRecord {
    const row = this.database.sqlite
      .prepare("select * from workflow_sessions where id = ?")
      .get(id) as WorkflowRow | undefined;
    if (!row) throw new Error(`Workflow session not found: ${id}`);
    return fromRow(row);
  }
}

function fromRow(row: WorkflowRow): WorkflowSessionRecord {
  let validation: WorkflowValidationEvidence[] = [];
  try {
    const parsed = JSON.parse(row.validation_json) as unknown;
    if (Array.isArray(parsed)) validation = parsed as WorkflowValidationEvidence[];
  } catch {
    validation = [];
  }
  return {
    id: row.id,
    workspaceSessionId: row.workspace_session_id,
    workspaceRoot: row.workspace_root,
    workspaceMode: row.workspace_mode as Workspace["mode"],
    ...(row.source_root ? { sourceRoot: row.source_root } : {}),
    ...(row.base_ref ? { baseRef: row.base_ref } : {}),
    ...(row.base_sha ? { baseSha: row.base_sha } : {}),
    managedWorktree: row.managed_worktree === "true",
    taskIntent: row.task_intent,
    status: row.status as WorkflowSessionStatus,
    validation,
    ...(row.review_ref ? { reviewRef: row.review_ref } : {}),
    ...(row.handoff_summary ? { handoffSummary: row.handoff_summary } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function boundedRequired(value: string, max: number, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must not be empty.`);
  if (trimmed.length > max) throw new Error(`${field} exceeds ${max} characters.`);
  return trimmed;
}

function boundedOptional(value: string, max: number): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw new Error(`value exceeds ${max} characters.`);
  return trimmed;
}
