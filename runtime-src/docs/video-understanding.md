# Video understanding

DevSpace treats video understanding as a model-orchestrated composition of bounded media primitives, not as a hidden server-side agent loop.

`read_video` accepts a workspace-relative video path and an optional `start_seconds` / `end_seconds` interval. A call without an interval samples the whole video coarsely. The host model reads the returned timestamped MCP `ImageContent` frames, identifies continuity gaps or uncertain spans, and calls `read_video` again with a narrower interval. Repeating that process gives progressively denser evidence without transferring the original video through MCP.

Each call returns at most eight frames and reuses the image batch payload limit. Extracted frames are written only to an internal temporary directory, converted to bounded JPEGs by the media sidecar, loaded into memory as MCP `ImageContent`, and removed before the tool returns. DevSpace does not currently expose a user-visible video preview or attachment surface.

## Decoder sidecar contract

Production `read_video` does not fall back to a system `ffmpeg`. The packaged Runtime must provide `vendor/ffmpeg/manifest.json` plus matching `ffmpeg` and `ffprobe` executables for the current platform. The manifest is fail-closed and must declare:

- `schema_version: 1`
- provider name, FFmpeg version, license identifier, and fixed release/source URL
- a `linux-x64` entry and a `win32-x64` entry
- relative paths and lowercase SHA-256 hashes for both `ffmpeg` and `ffprobe`

At first use, DevSpace verifies the manifest, checks path containment inside the sidecar directory, hashes both executables, and runs their version commands. A missing manifest, unsupported platform, hash mismatch, or unusable executable makes `read_video` fail instead of using an ambient decoder.

The binary provider is deliberately not hard-coded in the runtime implementation. Before a release bundles a provider, its exact versioned release asset, license obligations, source/build provenance, archive checksums, and Windows/Linux contents must be reviewed and captured by the release scripts. A historical release tag is not assumed immutable by itself; acceptance is pinned by SHA-256. In particular, a GPL-distributed convenience package must not be introduced into the MIT product merely because it is easy to install.

## Host workflow

1. Call `read_video(path)` for the first coarse pass.
2. Interpret the timestamped frames as a sequence, not as unrelated images.
3. Identify intervals where an event begins/ends between samples, motion is ambiguous, text changes, or continuity is otherwise insufficient.
4. Re-call `read_video(path, start_seconds, end_seconds)` for those intervals.
5. Repeat only where evidence remains insufficient; stop when the requested understanding is supported by the sampled frames.

Audio extraction/transcription and user-visible video preview are separate capabilities and are intentionally outside this first video primitive.

## Bundled provider candidate

The current packaging candidate is BtbN/FFmpeg-Builds `autobuild-2026-10-09-14-16`, stable FFmpeg `n8.1.3-16-ge0a878dd70-20261009`, using the `lgpl` static x64 assets. The build configuration uses `--enable-version3` and the included license file is GNU Lesser General Public License v3; the binary itself states version 3 or, at the user's option, any later version. DevSpace records this as `LGPL-3.0-or-later`.

`ops/video-sidecar-source.json` is the release source of truth for the provider, release tag, upstream checksums file, platform archive SHA-256 values, extracted executable SHA-256 values, and license-file SHA-256. `ops/prepare-video-sidecar.mjs` verifies those values before copying the sidecar into a Runtime package and writes `manifest.json` plus `PROVENANCE.json` next to the preserved `LICENSE.txt`. The sidecar remains a separate executable process; it is not linked into DevSpace.
