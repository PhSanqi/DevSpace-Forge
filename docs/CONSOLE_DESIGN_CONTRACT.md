# Control Console — Design Contract

## Art direction

Task-owned operator console. The page is a control surface, not a marketing
homepage or a telemetry wall. Information is organized by the operator's next
action, with read-only evidence visibly separated from writes.

## Information architecture

Eight destinations, each with one responsibility:

- Overview: health and a concise operational summary.
- Services: DevSpace and Tunnel lifecycle, including combined actions.
- Connection & Tunnel: endpoint copying, explicitly confirmed Owner credential
  copying, connection settings, Quick/Remote mode and live connection health.
- Deployment: actual process and configured slot, source provenance, verified
  rollback candidates and backups.
- DevSpace settings: tool mode, Review, Skills and logging.
- Projects & activity: Git commits, Review versions and safe code rollback;
  workspace, session and job inventory is a secondary disclosure.
- Config history: inspect, stage into both forms, or explicitly restore.
- Diagnostics: MCP request lifecycle, doctor, validation and logs.

No duplicate Owner copy or URL control in Services; no duplicate runtime restart
control in Deployment. The current process and the configured pointer must never
be presented as interchangeable. A staged historical snapshot remains staged
independently in Connection and DevSpace settings until each is saved.

## Composition and visual system

252px sidebar on desktop, maximum 1440px content width, 20px panel rhythm,
two-column comparisons where they add meaning, and one-column forms at mobile
breakpoints. Use the existing dark/light semantic tokens and restrained blue
accent. Status colors communicate health; destructive actions remain distinct.
Hierarchy: page title, section introduction, panel title, label, value. Dense
evidence is monospace and wraps within its panel; tables scroll locally rather
than expanding the page. The interface contains no decorative stock imagery.

## Interaction contract

Every write is a deliberate action. Saving configuration does not silently
restart services. Credential copying requires the existing confirmation and
never places a secret in routine status. Runtime rollback requires a verified
target and typed confirmation; project rollback rejects conflicting edits.
Unsaved non-secret form drafts survive navigation and refresh. Secret inputs
are not cached in drafts. Loading history stages both configuration forms and
does not imply that either has been saved.

Hover, focus, disabled, warning and error states must be visible. Keyboard
navigation, dialog focus and reduced-motion support are required. No new UI or
animation dependency is introduced.

## Anti-patterns

Do not split the same task between “core management” and “runtime observation.”
Do not repeat connection controls on service cards, or duplicate restart buttons
on deployment pages. Do not imply that an origin HTTP write proves client
receipt. Do not infer a Git revision from a package version or overwrite an
unsaved form during periodic polling.
