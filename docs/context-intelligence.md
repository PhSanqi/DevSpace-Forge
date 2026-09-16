# Local Context Intelligence Overlay

This branch keeps upstream DevSpace as the source of truth while adding a small,
rebaseable local overlay for long-running remote coding sessions.

## Long-term goal

Make DevSpace a context-intelligent execution layer: secure filesystem
boundaries, path-aware instructions, symbol-first code navigation, bounded
model-visible output, and locally retained full evidence. The host should spend
context on the code and facts that matter to the current task instead of whole
repositories, repeated instructions, or command transcripts.

The overlay should remain easy to reapply on newer official DevSpace releases.
Avoid forking provider orchestration, OAuth, workspace persistence, or other
unrelated product surfaces unless an upstream contract requires it.

## Invariants

1. **Upstream security wins.** Canonical path containment and symlink checks
   apply before context, semantic, read, edit, worktree, or shell operations.
2. **Instructions are lazy and path-scoped.** `open_workspace` loads global and
   workspace-root instructions only. Nested `AGENTS.md`/`CLAUDE.md` files are
   discovered along the target path when `read` or `context_pack` needs them.
3. **Symbols before files.** `context_pack` is the default source-context entry
   point. `semantic_code` is for precise relations. `read` is for a concrete
   range that remains necessary.
4. **Model output is bounded.** Reads, semantic results, and command previews
   have explicit budgets. Large command output is persisted locally and
   referenced by `run_id`.
5. **Evidence remains recoverable.** Compact output must never mean discarded
   output. `devspace-log` provides bounded `meta`, `read`, `tail`, `grep`, and
   byte-range retrieval from the local run store.
6. **Old sessions keep working.** Hosts that cache an older tool list can use
   the internal `devspace-context` and `devspace-semantic` compatibility forms
   through `exec_command`; these are intercepted by DevSpace and never passed
   to the shell.
7. **Edits remain explicit.** Semantic querying is read-only in the local
   overlay. Normal patch/edit tools retain change-review semantics.

## Context flow

For source investigation, use the following progression:

1. `context_pack(workspace_id, path, symbol?, intent?, depth?)`
2. `semantic_code(...)` when a specific definition/reference/implementation or
   diagnostic needs refinement.
3. `read(workspace_id, path, offset, limit)` only for the exact source range
   still required.
4. Run verification commands; inspect the compact preview first and retrieve
   more output with `devspace-log` only when needed.

`context_pack` combines, within a hard character budget:

- newly applicable nested instruction files;
- Serena/LSP symbol outline;
- Serena symbol identity/location plus a bounded source slice read directly
  from the symbol's `body_location`, avoiding oversized semantic bodies;
- references in standard/deep mode;
- implementations and diagnostics when the task intent or deep mode calls for
  them;
- a small file header as fallback context (or as additional deep context).

The tool degrades to path instructions plus a bounded file header when Serena
is unavailable.

## Upgrade discipline

When upstream publishes a new version:

1. create a clean checkpoint of this overlay;
2. rebase/cherry-pick upstream security and workspace changes first;
3. resolve conflicts in favor of upstream path/auth/workspace contracts;
4. reapply the smallest semantic/context changes needed;
5. run typecheck, security/workspace tests, context tests, server contract tests,
   and a real Serena smoke test;
6. build a parallel runtime and validate `/healthz`, `/mcp`, `doctor`, portable
   Git, semantic queries, and compact run-log retrieval before switching the
   production runtime;
7. retain the previous runtime as an immediate rollback point.

Do not directly edit the installed production `dist` as the development
workflow. Build from this branch and deploy the resulting runtime atomically.

