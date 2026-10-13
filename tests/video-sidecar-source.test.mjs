import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const descriptorUrl = new URL('../ops/video-sidecar-source.json', import.meta.url);
const linuxPackageUrl = new URL('../package-release-linux.sh', import.meta.url);
const windowsPrepareUrl = new URL('../prepare-offline-windows-runtime.ps1', import.meta.url);
const windowsPackageUrl = new URL('../package-release-windows-payload.ps1', import.meta.url);
const videoPrepareUrl = new URL('../ops/prepare-video-sidecar.mjs', import.meta.url);
const videoRuntimeSmokeUrl = new URL('../ops/video-sidecar-runtime-smoke.mjs', import.meta.url);
const sha256 = /^[a-f0-9]{64}$/;

test('video sidecar source is versioned, LGPL, and SHA-pinned on both platforms', async () => {
  const descriptor = JSON.parse(await readFile(descriptorUrl, 'utf8'));
  assert.equal(descriptor.schema_version, 1);
  assert.equal(descriptor.provider, 'BtbN/FFmpeg-Builds');
  assert.equal(descriptor.release_tag, 'autobuild-2026-10-09-14-16');
  assert.equal(descriptor.ffmpeg_version, 'n8.1.3-16-ge0a878dd70-20261009');
  assert.equal(descriptor.license, 'LGPL-3.0-or-later');
  assert.equal(
    descriptor.build_source_url,
    'https://github.com/BtbN/FFmpeg-Builds/tree/' + ('bd26828f0e965c2c6575' + '53584b09caf5d57eee52'),
  );
  assert.equal(
    descriptor.ffmpeg_source_url,
    'https://github.com/FFmpeg/FFmpeg/tree/' + ('e0a878dd704698302f45' + '3a8f646e20b21fd1c904'),
  );
  assert.match(descriptor.upstream_checksums_sha256, sha256);
  assert.doesNotMatch(descriptor.release_url, /\/latest(?:\/|$)/i);

  for (const key of ['linux-x64', 'win32-x64']) {
    const platform = descriptor.platforms[key];
    assert.ok(platform, `missing ${key}`);
    assert.ok(platform.archive.url.includes(`/releases/download/${descriptor.release_tag}/`));
    assert.doesNotMatch(platform.archive.url, /\/latest(?:\/|$)/i);
    assert.match(platform.archive.sha256, sha256);
    assert.match(platform.ffmpeg.sha256, sha256);
    assert.match(platform.ffprobe.sha256, sha256);
    assert.match(platform.license_file.sha256, sha256);
    assert.equal(platform.license_file.runtime_path, 'LICENSE.txt');
  }
});

test('product packaging injects and validates the video sidecar', async () => {
  const linux = await readFile(linuxPackageUrl, 'utf8');
  const windowsPrepare = await readFile(windowsPrepareUrl, 'utf8');
  const windowsPackage = await readFile(windowsPackageUrl, 'utf8');
  const videoPrepare = await readFile(videoPrepareUrl, 'utf8');
  const videoRuntimeSmoke = await readFile(videoRuntimeSmokeUrl, 'utf8');

  assert.match(linux, /prepare-video-sidecar\.mjs/);
  assert.match(linux, /--platform linux-x64/);
  assert.match(linux, /video-sidecar-runtime-smoke\.mjs/);
  assert.match(windowsPrepare, /prepare-video-sidecar\.mjs/);
  assert.match(windowsPrepare, /['"]--platform['"]\s*,\s*['"]win32-x64['"]/);
  assert.match(windowsPrepare, /video-sidecar-runtime-smoke\.mjs/);
  assert.match(windowsPrepare, /GitHubProxyPrefix/);
  assert.match(videoPrepare, /tmpdir\(\)/, 'Windows video smoke should be able to use the system short temp root');
  assert.match(videoPrepare, /devspace-video-smoke-/, 'Windows video smoke must avoid long release staging paths');
  assert.match(videoPrepare, /await copyFile\(executable, smokeExecutable\)/, 'Windows video smoke must execute a copied verified binary from the short path');
  assert.match(videoPrepare, /verifyFile\(smokeExecutable, platform\[label\]\.sha256/, 'short-path video smoke must preserve pinned binary verification');
  assert.match(videoRuntimeSmoke, /await cp\(vendorRoot, smokeVendorRoot, \{ recursive: true \}\)/, 'runtime video smoke must stage the complete sidecar on a short path');
  assert.match(videoRuntimeSmoke, /process\.env\.DEVSPACE_VIDEO_SIDECAR_DIR = smokeVendorRoot/, 'runtime video smoke must route readVideoForModel through the short sidecar copy');
  assert.match(videoRuntimeSmoke, /delete process\.env\.DEVSPACE_VIDEO_SIDECAR_DIR/, 'runtime video smoke must restore the caller sidecar environment');
  for (const item of ['manifest.json', 'bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE.txt', 'PROVENANCE.json']) {
    assert.ok(windowsPackage.includes(item), `Windows payload gate missing ${item}`);
  }
});
