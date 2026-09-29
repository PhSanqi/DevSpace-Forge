# Embedded DevSpace Runtime

This directory contains the DevSpace Runtime source built and shipped by DevSpace-Forge.
It is intentionally kept in the same repository as the Windows/Linux control and packaging
code so the public product has one source branch and one release line.

Upstream baseline: `Waishnav/devspace` `v1.1.0-beta.4`.
Embedded package version: `1.1.0-beta.4.local.15`.

The local integration includes audited workflow, durable-job, artifact/payload, request
lifecycle, context-intelligence and Serena semantic changes. Upstream DevSpace remains
the primary reference for security and runtime behavior. Changes in this directory must
pass its typecheck, test and build commands before a DevSpace-Forge release is produced.
