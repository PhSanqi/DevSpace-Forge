# Runtime Console — WebMaker design acceptance

Target: DevSpace-Forge / DevSpace Control Platform, not the unrelated WebMaker
application. WebMaker's `webmaker-frontend-aesthetic-optimization-loop` v1.3
was recalled as a **reusable skill** for this work. The current connector did
not expose the full `memhub_skill load` action; this report applies its available
Style Exploration → Art Direction → implementation → isolated visual audit →
acceptance protocol, without claiming to have loaded unavailable skill text or
to have performed an independent model review.

## Direction

The previous single dark `<pre>` diagnostic view is a useful fallback but not a
management product. A dense, console-first layout would continue hiding
version provenance and important errors in undifferentiated JSON. The selected
direction is an operator-facing system dashboard: persistent six-section
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
| Functional hierarchy | Six named sections, populated fixture data, distinct process vs pointer and Git provenance fields |
| Interaction | Mobile drawer opens and closes upon navigation; theme and language actually change |
| Accessibility | Skip link, semantic navigation/tables, visible keyboard focus, dialog labeling/focus, error announcement, reduced-motion |
| Resilience | Loading and error states, bounded request results, explicit unknown provenance, confirmation before a dangerous action |
| Safety | Local-only Host, CSP, no credentials in JSON, protected service POST and no public UI route |

Headless Edge produced all four viewport screenshots plus dialog/error captures,
with no browser exceptions. This is an **automated browser/design acceptance**,
not a claim that an independent human or model performed a subjective
pixel-by-pixel visual review. The final release gate remains real Linux/Windows
installation and actual Server runtime/PID/provenance verification, without
restarting the MCP or Tunnel solely to validate the page.
