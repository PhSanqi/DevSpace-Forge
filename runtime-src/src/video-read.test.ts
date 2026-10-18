import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  MAX_VIDEO_FRAMES,
  readVideoForModel,
  videoSampleTimestamps,
  type VideoBackend,
} from "./video-read.js";

test("videoSampleTimestamps becomes denser as the requested interval narrows", () => {
  const whole = videoSampleTimestamps(0, 120);
  const narrow = videoSampleTimestamps(30, 32);
  assert.equal(whole.length, MAX_VIDEO_FRAMES);
  assert.equal(narrow.length, 6);
  assert.ok(whole[0]! > 0 && whole.at(-1)! < 120);
  assert.ok(narrow[0]! > 30 && narrow.at(-1)! < 32);
  assert.ok((narrow[1]! - narrow[0]!) < (whole[1]! - whole[0]!));
});

test("readVideoForModel returns timestamped ImageContent payloads and removes temporary frames", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devspace-video-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "sample.mp4");
  await writeFile(videoPath, Buffer.from("fake-video-container"));
  const extractedPaths: string[] = [];
  const backend: VideoBackend = {
    identity: {
      provider: "test-backend",
      ffmpegVersion: "test-1",
      license: "test-only",
      sourceUrl: "https://example.invalid/test-backend",
    },
    async probe() {
      return {
        durationSeconds: 120,
        width: 1920,
        height: 1080,
        fps: 30,
        hasAudio: true,
        containerFormat: "mov,mp4,m4a,3gp,3g2,mj2",
      };
    },
    async extractFrame(_inputPath, timestampSeconds, outputPath) {
      extractedPaths.push(outputPath);
      await sharp({
        create: {
          width: 64,
          height: 36,
          channels: 3,
          background: {
            r: Math.round(timestampSeconds) % 255,
            g: 80,
            b: 160,
          },
        },
      }).jpeg().toFile(outputPath);
    },
  };

  const result = await readVideoForModel(
    videoPath,
    { startSeconds: 30, endSeconds: 50 },
    backend,
  );

  assert.equal(result.durationSeconds, 120);
  assert.equal(result.intervalStartSeconds, 30);
  assert.equal(result.intervalEndSeconds, 50);
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1080);
  assert.equal(result.hasAudio, true);
  assert.equal(result.frames.length, MAX_VIDEO_FRAMES);
  assert.ok(result.totalOutputBytes > 0);
  assert.equal(result.backend.provider, "test-backend");
  for (let index = 0; index < result.frames.length; index += 1) {
    const frame = result.frames[index]!;
    assert.equal(frame.image.mimeType, "image/jpeg");
    assert.ok(frame.image.data.length > 0);
    if (index > 0) {
      assert.ok(frame.timestampSeconds > result.frames[index - 1]!.timestampSeconds);
    }
  }
  for (const extractedPath of extractedPaths) {
    await assert.rejects(access(extractedPath));
  }
});

test("readVideoForModel fails closed for unsupported paths and invalid intervals", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devspace-video-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const textPath = path.join(root, "sample.txt");
  await writeFile(textPath, "not a video");
  const videoPath = path.join(root, "sample.mp4");
  await writeFile(videoPath, Buffer.from("fake-video-container"));
  const backend: VideoBackend = {
    identity: {
      provider: "test-backend",
      ffmpegVersion: "test-1",
      license: "test-only",
      sourceUrl: "https://example.invalid/test-backend",
    },
    async probe() {
      return {
        durationSeconds: 10,
        width: 640,
        height: 480,
        hasAudio: false,
      };
    },
    async extractFrame() {
      throw new Error("should not extract");
    },
  };

  await assert.rejects(readVideoForModel(textPath, {}, backend), /only supports/);
  for (const unsafe of ["https://example.com/video.mp4", "file:/tmp/video.mp4", "pipe:0", "-sample.mp4", "//example.com/video.mp4"]) {
    await assert.rejects(readVideoForModel(unsafe, {}, backend), /local file path/);
  }
  await assert.rejects(
    readVideoForModel(videoPath, { startSeconds: 9, endSeconds: 8 }, backend),
    /greater than start_seconds/,
  );
  await assert.rejects(
    readVideoForModel(videoPath, { startSeconds: 10 }, backend),
    /before the end of the video/,
  );
});

test("readVideoForModel avoids sampling beyond the last nominal frame", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devspace-video-tail-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const videoPath = path.join(root, "sample.mp4");
  await writeFile(videoPath, Buffer.from("fake-video-container"));
  const extractedTimestamps: number[] = [];
  const backend: VideoBackend = {
    identity: {
      provider: "test-backend",
      ffmpegVersion: "test-1",
      license: "test-only",
      sourceUrl: "https://example.invalid/test-backend",
    },
    async probe() {
      return {
        durationSeconds: 4,
        width: 320,
        height: 180,
        fps: 2,
        hasAudio: false,
      };
    },
    async extractFrame(_inputPath, timestampSeconds, outputPath) {
      extractedTimestamps.push(timestampSeconds);
      if (timestampSeconds > 3.5) throw new Error("timestamp is after the final frame");
      await sharp({
        create: { width: 32, height: 18, channels: 3, background: "#ffffff" },
      }).jpeg().toFile(outputPath);
    },
  };

  const result = await readVideoForModel(videoPath, {}, backend);
  assert.equal(result.frames.length, MAX_VIDEO_FRAMES);
  assert.equal(Math.max(...extractedTimestamps), 3.5);
  assert.equal(result.frames.at(-1)!.timestampSeconds, 3.5);
});


test("readVideoForModel isolates private calls and preserves unowned legacy directories", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devspace-video-recovery-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const prior = process.env.DEVSPACE_VIDEO_TEMP_DIR;
  process.env.DEVSPACE_VIDEO_TEMP_DIR = root;
  t.after(() => {
    if (prior === undefined) delete process.env.DEVSPACE_VIDEO_TEMP_DIR;
    else process.env.DEVSPACE_VIDEO_TEMP_DIR = prior;
  });

  const stale = path.join(root, "process-99999999", "call-stale");
  await mkdir(stale, { recursive: true });
  await writeFile(path.join(stale, "frame.jpg"), "stale");
  const videoPath = path.join(root, "sample.mp4");
  await writeFile(videoPath, Buffer.from("fake-video-container"));
  const callDirs = new Set<string>();
  const backend: VideoBackend = {
    identity: { provider: "test", ffmpegVersion: "1", license: "test", sourceUrl: "https://example.invalid" },
    async probe() { return { durationSeconds: 0.05, width: 64, height: 36, hasAudio: false }; },
    async extractFrame(_input, _timestamp, output) {
      const directory = path.dirname(output);
      callDirs.add(directory);
      assert.equal(path.dirname(directory), root);
      assert.match(path.basename(directory), /^call-/);
      if (process.platform !== "win32") assert.equal((await stat(directory)).mode & 0o777, 0o700);
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ffffff" } }).jpeg().toFile(output);
    },
  };

  const result = await readVideoForModel(videoPath, {}, backend);
  assert.equal(result.frames.length, 1);
  await Promise.all([readVideoForModel(videoPath, {}, backend), readVideoForModel(videoPath, {}, backend)]);
  assert.equal(callDirs.size, 3);
  for (const directory of callDirs) await assert.rejects(access(directory));
  await access(path.join(stale, "frame.jpg"));
});

test("packaged video executables receive only absolute local inputs and the file protocol", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devspace-video-protocol-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { chmod, readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const jpeg = path.join(root, "fixture.jpg");
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ffffff" } }).jpeg().toFile(jpeg);
  const records = path.join(root, "args.jsonl");
  const script = `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args[0]==='-version'){console.log('fixture');process.exit(0)}fs.appendFileSync(${JSON.stringify(records)},JSON.stringify(args)+'\\n');if(process.argv[1].endsWith('ffprobe'))console.log(JSON.stringify({format:{duration:'0.05'},streams:[{codec_type:'video',width:8,height:8}]}));else fs.copyFileSync(${JSON.stringify(jpeg)},args.at(-1));\n`;
  for (const name of ["ffprobe", "ffmpeg"]) {
    await writeFile(path.join(root, name), script);
    await chmod(path.join(root, name), 0o700);
  }
  const hash = createHash("sha256").update(script).digest("hex");
  await writeFile(path.join(root, "manifest.json"), JSON.stringify({
    schema_version: 1, provider: "test", ffmpeg_version: "test", license: "test", source_url: "https://example.com/source",
    platforms: { "linux-x64": { ffprobe: { path: "ffprobe", sha256: hash }, ffmpeg: { path: "ffmpeg", sha256: hash } } },
  }));
  const previous = process.env.DEVSPACE_VIDEO_SIDECAR_DIR;
  process.env.DEVSPACE_VIDEO_SIDECAR_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.DEVSPACE_VIDEO_SIDECAR_DIR; else process.env.DEVSPACE_VIDEO_SIDECAR_DIR = previous; });
  const video = path.join(root, "sample.mp4");
  await writeFile(video, "synthetic-container");
  const result = await readVideoForModel(path.relative(process.cwd(), video));
  assert.equal(result.frames.length, 1);
  const args = (await readFile(records, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
  assert.equal(args.length, 2);
  for (const invocation of args) {
    assert.equal(invocation[invocation.indexOf("-protocol_whitelist") + 1], "file");
    assert.ok(invocation.includes(video));
  }
});
