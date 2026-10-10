import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_IMAGE_BATCH_COUNT,
  readImageFiles,
  type ReadImageResult,
} from "./image-read.js";

export const MAX_VIDEO_SOURCE_BYTES = 16 * 1024 * 1024 * 1024;
export const MAX_VIDEO_DURATION_SECONDS = 24 * 60 * 60;
export const MAX_VIDEO_FRAMES = MAX_IMAGE_BATCH_COUNT;

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm"]);
const PROBE_TIMEOUT_MS = 15_000;
const FRAME_TIMEOUT_MS = 30_000;
const EXEC_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

export interface VideoProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  fps?: number;
  hasAudio: boolean;
  containerFormat?: string;
}

export interface VideoBackendIdentity {
  provider: string;
  ffmpegVersion: string;
  license: string;
  sourceUrl: string;
}

export interface VideoBackend {
  identity: VideoBackendIdentity;
  probe(videoPath: string): Promise<VideoProbeResult>;
  extractFrame(videoPath: string, timestampSeconds: number, outputPath: string): Promise<void>;
}

export interface ReadVideoFrame {
  timestampSeconds: number;
  image: ReadImageResult;
}

export interface ReadVideoModelResult {
  sourceSizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  fps?: number;
  hasAudio: boolean;
  containerFormat?: string;
  intervalStartSeconds: number;
  intervalEndSeconds: number;
  frames: ReadVideoFrame[];
  totalOutputBytes: number;
  backend: VideoBackendIdentity;
}

export interface ReadVideoOptions {
  startSeconds?: number;
  endSeconds?: number;
}

interface SidecarExecutable {
  path: string;
  sha256: string;
}

interface SidecarPlatformManifest {
  ffmpeg: SidecarExecutable;
  ffprobe: SidecarExecutable;
}

interface SidecarManifest {
  schema_version: 1;
  provider: string;
  ffmpeg_version: string;
  license: string;
  source_url: string;
  platforms: Record<string, SidecarPlatformManifest>;
}

interface FfprobeJson {
  format?: {
    duration?: string;
    format_name?: string;
  };
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    duration?: string;
    r_frame_rate?: string;
  }>;
}

let cachedPackagedBackend:
  | { cacheKey: string; backend: VideoBackend }
  | undefined;
let preparedVideoTemp:
  | { root: string; promise: Promise<string> }
  | undefined;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function videoTempRoot(): string {
  const configured = process.env.DEVSPACE_VIDEO_TEMP_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.tmpdir(), "devspace-video-frames");
}

async function prepareVideoProcessTemp(): Promise<string> {
  const root = videoTempRoot();
  if (preparedVideoTemp?.root === root) return preparedVideoTemp.promise;
  const promise = (async () => {
    await mkdir(root, { recursive: true });
    const ownRoot = path.join(root, `process-${process.pid}`);
    await rm(ownRoot, { recursive: true, force: true });
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = /^process-(\d+)$/.exec(entry.name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || processIsAlive(pid)) continue;
      await rm(path.join(root, entry.name), { recursive: true, force: true });
    }
    await mkdir(ownRoot, { recursive: true });
    return ownRoot;
  })();
  preparedVideoTemp = { root, promise };
  return promise;
}

function runExecutable(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: EXEC_OUTPUT_LIMIT_BYTES,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message).trim().slice(0, 4000);
          reject(new Error(detail || `${path.basename(executable)} exited with an error`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function runtimePackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function platformKey(): string {
  if (process.arch !== "x64") {
    throw new Error(`read_video backend does not support architecture ${process.arch}`);
  }
  if (process.platform === "linux") return "linux-x64";
  if (process.platform === "win32") return "win32-x64";
  throw new Error(`read_video backend does not support platform ${process.platform}`);
}

function sidecarRoot(): string {
  const configured = process.env.DEVSPACE_VIDEO_SIDECAR_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(runtimePackageRoot(), "vendor", "ffmpeg");
}

function resolveSidecarPath(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("read_video sidecar manifest contains an invalid executable path");
  }
  const resolved = path.resolve(root, relativePath);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new Error("read_video sidecar manifest path escapes its vendor directory");
  }
  return resolved;
}

function parseFraction(value?: string): number | undefined {
  if (!value) return undefined;
  const [numeratorText, denominatorText] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = denominatorText === undefined ? 1 : Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : undefined;
}

function parseDuration(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function loadPackagedBackend(): Promise<VideoBackend> {
  const root = sidecarRoot();
  const key = platformKey();
  const manifestPath = path.join(root, "manifest.json");
  const cacheKey = `${manifestPath}:${key}`;
  if (cachedPackagedBackend?.cacheKey === cacheKey) return cachedPackagedBackend.backend;

  let manifest: SidecarManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SidecarManifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`read_video backend is unavailable: ${message}`);
  }
  if (
    manifest.schema_version !== 1
    || !manifest.provider
    || !manifest.ffmpeg_version
    || !manifest.license
    || !manifest.source_url
  ) {
    throw new Error("read_video sidecar manifest is incomplete");
  }
  const platform = manifest.platforms?.[key];
  if (!platform?.ffmpeg?.path || !platform?.ffprobe?.path) {
    throw new Error(`read_video sidecar manifest does not contain ${key}`);
  }
  for (const executable of [platform.ffmpeg, platform.ffprobe]) {
    if (!/^[a-f0-9]{64}$/.test(executable.sha256)) {
      throw new Error("read_video sidecar manifest contains an invalid SHA256");
    }
  }

  const ffmpegPath = resolveSidecarPath(root, platform.ffmpeg.path);
  const ffprobePath = resolveSidecarPath(root, platform.ffprobe.path);
  for (const [label, filePath, expected] of [
    ["ffmpeg", ffmpegPath, platform.ffmpeg.sha256],
    ["ffprobe", ffprobePath, platform.ffprobe.sha256],
  ] as const) {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error(`read_video ${label} sidecar is not a regular file`);
    const actual = await sha256File(filePath);
    if (actual !== expected) throw new Error(`read_video ${label} SHA256 mismatch`);
  }

  await runExecutable(ffmpegPath, ["-version"], PROBE_TIMEOUT_MS);
  await runExecutable(ffprobePath, ["-version"], PROBE_TIMEOUT_MS);

  const identity: VideoBackendIdentity = {
    provider: manifest.provider,
    ffmpegVersion: manifest.ffmpeg_version,
    license: manifest.license,
    sourceUrl: manifest.source_url,
  };
  const backend: VideoBackend = {
    identity,
    async probe(videoPath) {
      const { stdout } = await runExecutable(
        ffprobePath,
        [
          "-v", "error",
          "-show_entries", "format=duration,format_name:stream=codec_type,width,height,duration,r_frame_rate",
          "-of", "json",
          videoPath,
        ],
        PROBE_TIMEOUT_MS,
      );
      let parsed: FfprobeJson;
      try {
        parsed = JSON.parse(stdout) as FfprobeJson;
      } catch {
        throw new Error("read_video ffprobe returned invalid JSON");
      }
      const video = parsed.streams?.find((stream) => stream.codec_type === "video");
      if (!video?.width || !video.height) throw new Error("read_video could not find a video stream");
      const durationSeconds = parseDuration(parsed.format?.duration) ?? parseDuration(video.duration);
      if (!durationSeconds) throw new Error("read_video could not determine video duration");
      return {
        durationSeconds,
        width: video.width,
        height: video.height,
        fps: parseFraction(video.r_frame_rate),
        hasAudio: parsed.streams?.some((stream) => stream.codec_type === "audio") ?? false,
        containerFormat: parsed.format?.format_name,
      };
    },
    async extractFrame(videoPath, timestampSeconds, outputPath) {
      await runExecutable(
        ffmpegPath,
        [
          "-hide_banner",
          "-loglevel", "error",
          "-nostdin",
          "-ss", timestampSeconds.toFixed(3),
          "-i", videoPath,
          "-map", "0:v:0",
          "-frames:v", "1",
          "-an",
          "-sn",
          "-dn",
          "-vf", "scale=1600:1600:force_original_aspect_ratio=decrease",
          "-q:v", "3",
          "-y",
          outputPath,
        ],
        FRAME_TIMEOUT_MS,
      );
      const metadata = await stat(outputPath);
      if (!metadata.isFile() || metadata.size === 0) {
        throw new Error("read_video ffmpeg did not produce a frame");
      }
    },
  };
  cachedPackagedBackend = { cacheKey, backend };
  return backend;
}

async function inspectVideoFile(videoPath: string): Promise<number> {
  const extension = path.extname(videoPath).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(extension)) {
    throw new Error("read_video only supports .mp4, .mov, .m4v, .mkv, and .webm files");
  }
  const metadata = await stat(videoPath);
  if (!metadata.isFile()) throw new Error("read_video target is not a regular file");
  if (metadata.size <= 0) throw new Error("read_video target is empty");
  if (metadata.size > MAX_VIDEO_SOURCE_BYTES) {
    throw new Error(`read_video file exceeds ${MAX_VIDEO_SOURCE_BYTES} bytes`);
  }
  return metadata.size;
}

function normalizeInterval(
  durationSeconds: number,
  options: ReadVideoOptions,
): { startSeconds: number; endSeconds: number } {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("read_video backend returned an invalid duration");
  }
  if (durationSeconds > MAX_VIDEO_DURATION_SECONDS) {
    throw new Error(`read_video duration exceeds ${MAX_VIDEO_DURATION_SECONDS} seconds`);
  }
  const startSeconds = options.startSeconds ?? 0;
  const requestedEnd = options.endSeconds ?? durationSeconds;
  if (!Number.isFinite(startSeconds) || startSeconds < 0) {
    throw new Error("read_video start_seconds must be a finite non-negative number");
  }
  if (!Number.isFinite(requestedEnd) || requestedEnd <= 0) {
    throw new Error("read_video end_seconds must be a finite positive number");
  }
  if (startSeconds >= durationSeconds) {
    throw new Error("read_video start_seconds must be before the end of the video");
  }
  const endSeconds = Math.min(requestedEnd, durationSeconds);
  if (endSeconds <= startSeconds) {
    throw new Error("read_video end_seconds must be greater than start_seconds");
  }
  return { startSeconds, endSeconds };
}

function sampleCount(spanSeconds: number): number {
  if (spanSeconds <= 0.1) return 1;
  if (spanSeconds <= 0.5) return 4;
  if (spanSeconds <= 2) return 6;
  return MAX_VIDEO_FRAMES;
}

export function videoSampleTimestamps(startSeconds: number, endSeconds: number): number[] {
  const spanSeconds = endSeconds - startSeconds;
  if (!(spanSeconds > 0)) throw new Error("video sampling interval must be positive");
  const count = sampleCount(spanSeconds);
  if (count === 1) return [startSeconds + (spanSeconds / 2)];
  const edgeInset = Math.min(0.05, spanSeconds / 20);
  const first = startSeconds + edgeInset;
  const last = endSeconds - edgeInset;
  return Array.from({ length: count }, (_, index) => (
    first + ((last - first) * index) / (count - 1)
  ));
}

export async function readVideoForModel(
  videoPath: string,
  options: ReadVideoOptions = {},
  backend?: VideoBackend,
): Promise<ReadVideoModelResult> {
  const sourceSizeBytes = await inspectVideoFile(videoPath);
  const activeBackend = backend ?? await loadPackagedBackend();
  const probe = await activeBackend.probe(videoPath);
  if (!Number.isInteger(probe.width) || probe.width <= 0 || !Number.isInteger(probe.height) || probe.height <= 0) {
    throw new Error("read_video backend returned invalid video dimensions");
  }
  const interval = normalizeInterval(probe.durationSeconds, options);
  const timestamps = videoSampleTimestamps(interval.startSeconds, interval.endSeconds);
  const processTemp = await prepareVideoProcessTemp();
  const tempDir = await mkdtemp(path.join(processTemp, "call-"));
  const framePaths = timestamps.map((_, index) => path.join(tempDir, `frame-${String(index).padStart(2, "0")}.jpg`));
  try {
    for (let index = 0; index < timestamps.length; index += 1) {
      await activeBackend.extractFrame(videoPath, timestamps[index]!, framePaths[index]!);
    }
    const batch = await readImageFiles(framePaths);
    return {
      sourceSizeBytes,
      durationSeconds: probe.durationSeconds,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
      containerFormat: probe.containerFormat,
      intervalStartSeconds: interval.startSeconds,
      intervalEndSeconds: interval.endSeconds,
      frames: batch.images.map((image, index) => ({
        timestampSeconds: timestamps[index]!,
        image,
      })),
      totalOutputBytes: batch.totalSizeBytes,
      backend: activeBackend.identity,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
