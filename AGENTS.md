# Contribution guidance

This repository is public. Keep documentation, screenshots, test fixtures, default settings and release assets suitable for a general audience.

- Use example.com and synthetic data in examples and tests. Never commit a real public/private hostname, account identifier, home-directory path, Tunnel token, API credential, Owner password or production log.
- Keep runtime, configuration and credentials instance-scoped. Do not print plaintext secrets in diagnostics.
- Preserve Windows and Linux support; source tests alone do not prove an installed release works.
- Keep the management Console loopback-only, the public MCP/OAuth endpoint separate, and optional gateway origins configurable.
- Before publishing, run tests and the public-repository privacy audit. Maintain user-facing installation and upgrade instructions in both README languages.
- Any real deployment, private release provenance, security review output or operational status belongs outside this public repository.
