# Roadmap / 路线图

Updated: 2026-09-26. This is a product roadmap, not a claim that every experimental feature is deployed.

## Shipped and validated

- Windows and Linux x64 offline Control packages, with a shared tagged Runtime, pinned Node.js and cloudflared.
- Allowed Roots, project-aware Git/worktrees, Review checkpoints and safe project rollback.
- Long command evidence through stable `run_id`; durable Job IDs, status, logs, cancellation, and reconnect-safe discovery.
- Linux long-running jobs launched under independent user-systemd units, with active-job preflight and a shared switch gate to prevent unsafe Runtime restarts. Windows native lifecycle/JobObject isolation has dedicated regression coverage.
- Local management Console: services, configuration/history, projects, Runtime identity and rollback, logs, tunnel and request diagnostics; Chinese/English, light/dark and responsive layout.
- Canonical Cloudflare path gateway: same-host HTTP→HTTPS redirects, HTTPS origin fetch, HSTS on server/group, and preservation of MCP/OAuth paths.
- Immutable release provenance and SHA-256 checks for the Linux/Windows deliverables.

## Next work

1. Keep Windows and Linux installed-state acceptance distinct from successful CI packaging. Verify each installer and actual Runtime upgrade with an isolated active durable job.
2. Improve first-class bounded Workflow Session evidence above workspaces: task intent, worktree, validation, review and handoff/resume.
3. Complete explicit managed worktree finish/prune hygiene and structured validation recipes.
4. Continue cross-platform accessibility and native-browser acceptance without changing users' global proxy or weakening browser sandbox.

## Deferred

Central multi-machine orchestrator, multi-tenant grants and a second subagent manager are not part of the current single-machine-first product. Subagents remain disabled in the Control distribution.

See [CURRENT_TRUTH.md](CURRENT_TRUTH.md) for dated deployed-state evidence and [PLATFORMS.md](PLATFORMS.md) for independent release versions.
