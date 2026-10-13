#!/usr/bin/env node
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument: ${key ?? ""}`);
    out[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
    index += 1;
  }
  return out;
}

function platformKey() {
  if (process.arch !== "x64") throw new Error(`Unsupported architecture: ${process.arch}`);
  if (process.platform === "linux") return "linux-x64";
  if (process.platform === "win32") return "win32-x64";
  throw new Error(`Unsupported platform: ${process.platform}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.packageRoot) throw new Error("--package-root is required");
  const packageRoot = path.resolve(args.packageRoot);
  const vendorRoot = path.join(packageRoot, "vendor", "ffmpeg");
  const manifest = JSON.parse(await readFile(path.join(vendorRoot, "manifest.json"), "utf8"));
  const platform = manifest.platforms?.[platformKey()];
  if (!platform?.ffmpeg?.path) throw new Error("Video sidecar manifest does not contain ffmpeg for this platform");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "devspace-video-sidecar-smoke-"));
  const smokeVendorRoot = path.join(tempRoot, "ffmpeg");
  await cp(vendorRoot, smokeVendorRoot, { recursive: true });
  const ffmpeg = path.resolve(smokeVendorRoot, platform.ffmpeg.path);
  const video = path.join(tempRoot, "source.mp4");
  const frameTemp = path.join(tempRoot, "frames");
  const previousTemp = process.env.DEVSPACE_VIDEO_TEMP_DIR;
  const previousSidecar = process.env.DEVSPACE_VIDEO_SIDECAR_DIR;
  try {
    process.env.DEVSPACE_VIDEO_SIDECAR_DIR = smokeVendorRoot;
    await execFileAsync(
      ffmpeg,
      [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=2",
        "-t", "4", "-c:v", "mpeg4", "-q:v", "5", "-y", video,
      ],
      { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
    process.env.DEVSPACE_VIDEO_TEMP_DIR = frameTemp;
    const { readVideoForModel } = await import(pathToFileURL(path.join(packageRoot, "dist", "video-read.js")));
    const coarse = await readVideoForModel(video);
    const refined = await readVideoForModel(video, { startSeconds: 1, endSeconds: 2 });
    if (coarse.frames.length !== 8) throw new Error(`Unexpected coarse frame count: ${coarse.frames.length}`);
    if (refined.frames.length !== 6) throw new Error(`Unexpected refined frame count: ${refined.frames.length}`);
    const processRoot = path.join(frameTemp, `process-${process.pid}`);
    const leftovers = await readdir(processRoot).catch(() => []);
    if (leftovers.length !== 0) throw new Error(`Temporary video frames were not removed: ${leftovers.join(", ")}`);
    process.stdout.write(
      `Video sidecar runtime smoke: ${platformKey()} / coarse=${coarse.frames.length} / refined=${refined.frames.length} / cleanup=ok\n`,
    );
  } finally {
    if (previousTemp === undefined) delete process.env.DEVSPACE_VIDEO_TEMP_DIR;
    else process.env.DEVSPACE_VIDEO_TEMP_DIR = previousTemp;
    if (previousSidecar === undefined) delete process.env.DEVSPACE_VIDEO_SIDECAR_DIR;
    else process.env.DEVSPACE_VIDEO_SIDECAR_DIR = previousSidecar;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`video-sidecar-runtime-smoke: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
