# Runtime Console — WebMaker design acceptance

Target: DevSpace-Forge / DevSpace Control Platform, not the unrelated WebMaker
application. WebMaker's `webmaker-frontend-aesthetic-optimization-loop` v1.4
was recalled as a **reusable skill** for this work. The current connector did
not expose the full `memhub_skill load` action; this report applies its available
Style Exploration → Art Direction → implementation → isolated visual audit →
acceptance protocol, without claiming to have loaded unavailable skill text or
to have performed an independent model review.

## Direction

The previous single dark `<pre>` diagnostic view is a useful fallback but not a
management product. A dense, console-first layout would continue hiding
version provenance and important errors in undifferentiated JSON. The selected
direction is an operator-facing control product with two explicit layers.
**Core Management** comes first and mirrors the operational Windows manager:
services/access, connection config, DevSpace config, Projects/Git, logs/diagnostics
and config history. **Runtime Observation** is secondary and contains the
diagnostic dashboard pages. This prevents monitoring cards from displacing the
controls needed to operate and recover the instance.

Tokens: navy surfaces with restrained azure accent, reserved green/amber/red
operational states, neutral light theme, spacious section panels, responsive
two-column/four-stat layouts. No external fonts, logos, or third-party assets
are required; this remains a small self-contained offline administration tool.

## Acceptance rubric / evidence

The isolated browser run uses **actual viewport widths** rather than merely a
user-agent/mobile emulation label. Results are recorded in the ignored
`tests/.review-runtime/browser-acceptance.json` and screenshots.

| Check | Evidence / expected behavior |
| --- | --- |
| Desktop | 1440px Chinese/dark Services and English/light Projects/Git |
| Mobile | 390px Chinese/dark Connection config and English/light DevSpace config, no page-level horizontal overflow |
| Functional hierarchy | 12 navigation entries split into Core Management and Runtime Observation |
| Windows parity | Service control, access copy, connection/config fields, Project/Git versions, diagnostics and config-history surfaces |
| Connection/access | Configured MCP URL copy, masked credential and explicit owner-copy confirmation |
| Code rollback | Select an earlier active DevSpace Review version; current/archived versions are not valid targets |
| Runtime rollback | Select a specific installed runtime, see its path/hash, require the matching target ID to confirm |
| Layout regression | Runtime rollback, backups and protected operations are vertically separated; bounding boxes do not overlap |
| Interaction | Mobile drawer opens and closes upon navigation; theme and language actually change |
| Accessibility | Skip link, semantic navigation/tables, visible keyboard focus, dialog labeling/focus, error announcement, reduced-motion |
| Resilience | Loading and error states, bounded request results, explicit unknown provenance, confirmation before a dangerous action |
| Safety | Local-only Host and CSP; `/api/status` and HTML never contain credentials; Owner Password is returned only by the explicitly confirmed same-origin credential action; protected service POSTs; no public UI route |

Headless Edge produced all four core-management viewport screenshots plus
service/access, Project/Git version selection, code-rollback confirmation,
runtime-rollback selection/layout, dialog/error and accessibility captures,
with no browser exceptions. This is an **automated browser/design acceptance**,
not a claim that an independent human or model performed a subjective
pixel-by-pixel visual review. The final release gate remains real Linux/Windows
installation and actual Server runtime/PID/provenance verification, without
restarting the MCP or Tunnel solely to validate the page.
