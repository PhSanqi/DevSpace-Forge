import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  await assert.rejects(
    readVideoForModel(videoPath, { startSeconds: 9, endSeconds: 8 }, backend),
    /greater than start_seconds/,
  );
  await assert.rejects(
    readVideoForModel(videoPath, { startSeconds: 10 }, backend),
    /before the end of the video/,
  );
});


test("readVideoForModel removes stale frame directories left by dead processes", async (t) => {
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
  const backend: VideoBackend = {
    identity: { provider: "test", ffmpegVersion: "1", license: "test", sourceUrl: "https://example.invalid" },
    async probe() { return { durationSeconds: 0.05, width: 64, height: 36, hasAudio: false }; },
    async extractFrame(_input, _timestamp, output) {
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ffffff" } }).jpeg().toFile(output);
    },
  };

  const result = await readVideoForModel(videoPath, {}, backend);
  assert.equal(result.frames.length, 1);
  await assert.rejects(access(path.join(root, "process-99999999")));
});
