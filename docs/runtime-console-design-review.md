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
direction is an operator-facing system dashboard: persistent seven-section
navigation; clear service/health hierarchy; separate configured and running
versions; monospace identities and hashes; bounded tables for diagnostics and
workspaces; explicit uncertainty instead of invented Git revisions.

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
| Desktop | 1440px Chinese/dark overview and English/light runtime |
| Mobile | 390px Chinese/dark overview and English/light requests, no page-level horizontal overflow |
| Functional hierarchy | Seven named sections, populated fixture data, distinct process vs pointer and Git provenance fields |
| Connection/access | Configured MCP URL copy, masked credential and explicit owner-copy confirmation |
| Rollback | Select a specific installed version, see its path/hash, require the matching target ID to confirm |
| Interaction | Mobile drawer opens and closes upon navigation; theme and language actually change |
| Accessibility | Skip link, semantic navigation/tables, visible keyboard focus, dialog labeling/focus, error announcement, reduced-motion |
| Resilience | Loading and error states, bounded request results, explicit unknown provenance, confirmation before a dangerous action |
| Safety | Local-only Host and CSP; `/api/status` and HTML never contain credentials; Owner Password is returned only by the explicitly confirmed same-origin credential action; protected service POSTs; no public UI route |

Headless Edge produced all four viewport screenshots plus dialog/error captures,
with no browser exceptions. This is an **automated browser/design acceptance**,
not a claim that an independent human or model performed a subjective
pixel-by-pixel visual review. The final release gate remains real Linux/Windows
installation and actual Server runtime/PID/provenance verification, without
restarting the MCP or Tunnel solely to validate the page.
