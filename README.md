# DevSpace-Forge

[简体中文](README.zh-CN.md) · [Installation guide](docs/getting-started.md) · [Releases and upgrades](docs/releases-and-upgrades.md)

**Stay in the conversation. Build on your own machine.**

DevSpace-Forge connects an MCP-capable AI chat client to development folders you approve on Windows or Linux. Discuss a change, inspect a repository, edit files, run tests, review the result and continue in the same conversation—without repeatedly moving code between chat, an editor and a terminal.

This is a community-built, self-hosted project, not an official OpenAI or Cloudflare product. Client features, context retention and usage limits depend on the client and its subscription. DevSpace-Forge does not grant AI credits, bypass quotas or promise unlimited memory.

## What's new in v0.6.12

- **Modern Windows control plane:** the Windows package now uses one modern Desktop launcher to coordinate the local Control console, Runtime and Tunnel. Upgrades remove the legacy launcher ownership instead of running two managers side by side.
- **Safer multi-instance startup:** the Windows Control instance is derived from the configured public route rather than being fixed to one deployment name, so reusable installations such as `/team-a` and `/team-b` keep their own identity.
- **More reliable offline Windows packaging:** Runtime and video dependencies are staged through bounded short paths before packaging and smoke tests, reducing failures caused by Windows path-length and native dependency handling.
- **Stronger media delivery checks:** image-generation workflows now verify that generated media is actually delivered through the supported media path instead of treating generation alone as success.
- **Public-repository hygiene:** public documentation, examples, tests and release metadata use generic placeholders and non-personal Git identities. Deployment hostnames, credentials and local machine paths remain local configuration.

See [v0.6.12 release notes](docs/release-notes-v0.6.12.md) for upgrade details and verification guidance.

## What you get

- **Chat-to-local development:** read and modify approved files, run local commands, builds, tests and Git operations through MCP.
- **Local image understanding and visual round-trip:** `read_image` reads one workspace JPG/PNG and `read_images` compares up to eight images. They return real MCP `ImageContent`, not base64 pasted into text. When MCP Apps UI is enabled, DevSpace also renders those exact returned pixels in its media card so a see/show/send request does not depend on the model reconstructing the image in prose or HTML. Very large or long images are reduced locally to a bounded overview plus detail tiles.
- **Adaptive video understanding:** `read_video` samples a workspace video into timestamped MCP image frames. The host model can inspect a coarse whole-video pass, identify uncertain intervals, then call `read_video` again on narrower time ranges for denser evidence. When MCP Apps UI is enabled, the sampled frames are shown in the same media card. Each call stays bounded to at most eight frames; the original video is not uploaded through MCP.
- **Less context handoff:** bring project files, Git state and command results into the same conversation. The AI client's context window still applies.
- **Scoped access:** you explicitly choose Allowed Roots.
- **Review and recovery:** inspect changes, command evidence, review checkpoints, durable job status and logs.
- **Two platforms:** offline Windows x64 and Linux x64 packages include the pinned Runtime, Node.js and cloudflared.
- **Optional remote access:** connect through your own Cloudflare Tunnel. The privileged management Console stays on loopback, not at the public MCP URL.

DevSpace keeps standard MCP image content as the model-input and compatibility path. With MCP Apps UI enabled, `read_image`, `read_images`, and `read_video` additionally show the same returned pixels in a DevSpace media card without duplicating the image payload into structured output. A client with neither MCP Apps nor native MCP image rendering can still pass those pixels to the model without showing them inline. `read_video` provides visible sampled frames, not a full video player; audio transcription and video playback remain separate capabilities.

## Quick start

Open this repository's **Releases** tab and download the latest archive and its matching SHA-256 file.

Control and the embedded Runtime are built from the same `main` revision and ship together on one public product release line. You do not need to match a separate Runtime release to a Control package.

| Platform | Archive pattern | Start |
| --- | --- | --- |
| Windows x64 | DevSpace-Forge-vX.Y.Z-win-x64.zip | Extract and run Setup.exe |
| Linux x64 | DevSpace-Forge-vX.Y.Z-linux-x64.tar.gz | Extract and run ./setup-linux.sh |

1. Verify the archive using its accompanying checksum.
2. On Windows, run `Setup.exe` and follow the guided wizard. Confirm that you control a domain and that the domain is active in Cloudflare.
3. Create a Cloudflare Tunnel. Setup shows the detected Windows architecture. In Cloudflare, select the matching environment, then **copy the complete Install and Run command into Setup**. You do not need to extract the Tunnel token manually or install a second `cloudflared` service yourself.
4. After the Tunnel is Healthy, add a **Published application** route. Setup shows the exact local Service URL to paste into Cloudflare; choose your own hostname and save the route.
5. Select the project root the assistant may access and confirm installation. Then connect an MCP-capable client to the displayed HTTPS `/mcp` URL and complete the initial Owner approval locally.
6. Ask the assistant to inspect a project, make a small change, run its tests and show the diff.

Example public MCP endpoint: https://workspace.example.com/mcp. This is an illustration, not a service operated by this project. Do not commit real Tunnel tokens, passwords or API credentials, or post them in issues or screenshots. The Windows wizard parses the complete Cloudflare command into a protected local credential, so normal setup does not require placing the token in shell history.

For the complete procedure, see [Installation and connection](docs/getting-started.md).

## How it works

The Runtime executes on your own machine. On Windows, the modern Desktop launcher coordinates the loopback Control console and managed services; on Linux, the local Console supervises the instance. An optional Tunnel forwards only the selected MCP endpoint. Projects, credentials, state and command logs remain local; tools and paths are limited to what you authorize. Inspect changes before destructive actions.

An optional multi-instance gateway is separate from the ordinary installer. Its origin hosts must be provided through deployment configuration rather than committed to the project. See the [gateway example](ops/CLOUDFLARE-GATEWAY.md).

The optional landing page in the site directory is a static website, **not** the management Console or MCP endpoint. It accepts the public hostname and repository URL at deployment time. See [Self-hosting the website](docs/public-website.md).

## Documentation

- [Installation and connection](docs/getting-started.md)
- [Windows and Linux packages](PLATFORMS.md)
- [Releases, verification and safe upgrades](docs/releases-and-upgrades.md)
- [v0.6.12 release notes](docs/release-notes-v0.6.12.md)
- [Image and context intelligence](runtime-src/docs/context-intelligence.md)
- [Adaptive video understanding](runtime-src/docs/video-understanding.md)
- [Using the local Console](docs/runtime-console.md)
- [Optional public website](docs/public-website.md)
- [Product roadmap](ROADMAP.md)

## Upstream and license

This project builds on the open-source DevSpace ecosystem, including [Waishnav/devspace](https://github.com/Waishnav/devspace) and [devspace-verge](https://github.com/yuezhihuafou/devspace-verge). The pinned, integrated Runtime source lives in [`runtime-src/`](runtime-src/) and is built from the same `main` revision as the Windows/Linux product packages; there is no separate public Runtime branch or Runtime release line. Distribution and integration work in this repository is provided under the [MIT License](LICENSE); upstream projects retain their own attribution.
