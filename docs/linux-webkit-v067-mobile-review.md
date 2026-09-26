# Linux Web management mobile review (2026-09-26)

Production v0.6.6 was inspected using native Linux Playwright WebKit against
`http://127.0.0.1:17678/` without changing the system Chrome sandbox or
global proxy. The WebKit runtime was confined to the user cache; its missing
libraries were downloaded and extracted to a temporary, user-owned directory
without installing or modifying host packages.

The initial load had zero JavaScript/console errors, loaded 220 rules from
`/ui.css`, and all eight navigation views rendered. At 1440px and 390px,
document width matched viewport width, with the mobile menu opening and
closing correctly. Screenshots are local review evidence, not immutable
release artifacts.

The 390px overview nevertheless exposed a clipped Runtime version value:
`1.1.0-beta.4.local.15`. Its metric text had clientWidth=107,
scrollWidth=139 and its second line extended beyond the containing card
(right=207 vs card right=190). An isolated browser route that substituted only
the candidate CSS verified that `overflow-wrap:anywhere` yields
clientWidth=scrollWidth=107 and all three text lines stay inside the card.
The scoped fix also gives metric cards `min-width:0` and permits wrapping of
their source detail. It does not alter the data or runtime identity.

Playwright screenshot capture injects a transient inline stylesheet, which
triggers the intentionally restrictive page CSP `style-src 'self'`.
No error appeared before screenshots; the ordinary linked stylesheet loaded
and was applied. Do not loosen the production CSP to accommodate Playwright's
screenshot instrumentation.

This is the source and isolated-browser acceptance for the v0.6.7 mobile CSS
candidate. A subsequent official release and production check must independently
verify the deployed CSS checksum and the same 390px metric geometry.
