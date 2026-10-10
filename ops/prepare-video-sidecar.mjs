#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DESCRIPTOR = path.join(ROOT, 'ops', 'video-sidecar-source.json');
const MAX_COMMAND_OUTPUT = 8 * 1024 * 1024;

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--') || !argv[index + 1]) throw new Error(`Invalid argument: ${item}`);
    out[item.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++index];
  }
  return out;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function contained(root, relative) {
  if (!relative || path.isAbsolute(relative)) throw new Error(`Invalid relative path: ${relative}`);
  const resolved = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(prefix)) throw new Error(`Path escapes root: ${relative}`);
  return resolved;
}

async function run(executable, args, { cwd, timeoutMs = 120_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(executable)} timed out`));
    }, timeoutMs);
    const append = (current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      if (next.byteLength > MAX_COMMAND_OUTPUT) throw new Error(`${path.basename(executable)} output exceeded limit`);
      return next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.toString('utf8').trim().slice(0, 4000);
        reject(new Error(`${path.basename(executable)} failed (${signal ?? code}): ${detail}`));
        return;
      }
      resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });
  });
}

async function verifyFile(file, expected, label) {
  const metadata = await stat(file);
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file`);
  const actual = await sha256File(file);
  if (actual !== expected) throw new Error(`${label} SHA256 mismatch: expected ${expected}, got ${actual}`);
  return actual;
}

async function download(url, target, expectedSha) {
  try {
    if ((await sha256File(target)) === expectedSha) return;
  } catch {}
  await rm(`${target}.partial`, { force: true });
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(`${target}.partial`, { mode: 0o600 }));
      await verifyFile(`${target}.partial`, expectedSha, 'video sidecar archive');
      await rename(`${target}.partial`, target);
      return;
    } catch (error) {
      lastError = error;
      await rm(`${target}.partial`, { force: true });
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw lastError ?? new Error('video sidecar download failed');
}

function validateDescriptor(value) {
  if (value?.schema_version !== 1 || !value.provider || !value.ffmpeg_version || !value.license || !value.release_url) {
    throw new Error('video sidecar descriptor is incomplete');
  }
  for (const key of ['linux-x64', 'win32-x64']) {
    const platform = value.platforms?.[key];
    if (!platform?.archive?.name || !platform.archive.url || !/^[a-f0-9]{64}$/.test(platform.archive.sha256)) {
      throw new Error(`video sidecar descriptor is missing ${key} archive metadata`);
    }
    for (const name of ['ffmpeg', 'ffprobe', 'license_file']) {
      const entry = platform[name];
      if (!entry?.archive_path || !entry.runtime_path || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw new Error(`video sidecar descriptor is missing ${key}.${name}`);
      }
    }
  }
}

function runtimeManifest(descriptor) {
  const platforms = {};
  for (const key of ['linux-x64', 'win32-x64']) {
    const platform = descriptor.platforms[key];
    platforms[key] = {
      ffmpeg: { path: platform.ffmpeg.runtime_path, sha256: platform.ffmpeg.sha256 },
      ffprobe: { path: platform.ffprobe.runtime_path, sha256: platform.ffprobe.sha256 },
    };
  }
  return {
    schema_version: 1,
    provider: descriptor.provider,
    ffmpeg_version: descriptor.ffmpeg_version,
    license: descriptor.license,
    source_url: descriptor.release_url,
    platforms,
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.platform || !['linux-x64', 'win32-x64'].includes(args.platform)) {
    throw new Error('--platform must be linux-x64 or win32-x64');
  }
  if (!args.target) throw new Error('--target is required');
  if (!args.cache) throw new Error('--cache is required');
  const hostPlatform = process.arch === 'x64'
    ? (process.platform === 'linux' ? 'linux-x64' : process.platform === 'win32' ? 'win32-x64' : '')
    : '';
  if (!hostPlatform || args.platform !== hostPlatform) {
    throw new Error(`--platform ${args.platform} does not match host ${process.platform}-${process.arch}`);
  }

  const descriptorPath = path.resolve(args.descriptor ?? DEFAULT_DESCRIPTOR);
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
  validateDescriptor(descriptor);
  const platform = descriptor.platforms[args.platform];
  const target = path.resolve(args.target);
  const targetMetadata = await stat(target);
  if (!targetMetadata.isDirectory()) throw new Error('--target must be an existing directory');
  const cache = path.resolve(args.cache);
  await mkdir(cache, { recursive: true });
  const archive = path.join(cache, platform.archive.name);
  await download(platform.archive.url, archive, platform.archive.sha256);
  await verifyFile(archive, platform.archive.sha256, `${args.platform} archive`);

  const extract = await mkdtemp(path.join(cache, `.extract-${args.platform}-`));
  const vendor = path.join(target, 'vendor', 'ffmpeg');
  try {
    const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
    const extractArgs = args.platform === 'linux-x64'
      ? ['-xJf', archive, '-C', extract]
      : ['-xf', archive, '-C', extract];
    await run(tar, extractArgs, { timeoutMs: 10 * 60 * 1000 });

    const sourceRoot = contained(extract, platform.archive.root);
    const verified = {};
    for (const name of ['ffmpeg', 'ffprobe', 'license_file']) {
      const entry = platform[name];
      const source = contained(sourceRoot, entry.archive_path);
      await verifyFile(source, entry.sha256, `${args.platform} ${name}`);
      verified[name] = source;
    }

    await rm(vendor, { recursive: true, force: true });
    for (const name of ['ffmpeg', 'ffprobe', 'license_file']) {
      const entry = platform[name];
      const destination = contained(vendor, entry.runtime_path);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(verified[name], destination);
      if (name !== 'license_file' && args.platform === 'linux-x64') await chmod(destination, 0o755);
      await verifyFile(destination, entry.sha256, `packaged ${args.platform} ${name}`);
    }

    await writeFile(path.join(vendor, 'manifest.json'), `${JSON.stringify(runtimeManifest(descriptor), null, 2)}\n`, 'utf8');
    const provenance = {
      schema_version: 1,
      provider: descriptor.provider,
      release_tag: descriptor.release_tag,
      ffmpeg_version: descriptor.ffmpeg_version,
      license: descriptor.license,
      release_url: descriptor.release_url,
      build_source_url: descriptor.build_source_url,
      ffmpeg_source_url: descriptor.ffmpeg_source_url,
      upstream_checksums_url: descriptor.upstream_checksums_url,
      upstream_checksums_sha256: descriptor.upstream_checksums_sha256,
      platform: args.platform,
      archive: platform.archive,
    };
    await writeFile(path.join(vendor, 'PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');

    const ffmpeg = contained(vendor, platform.ffmpeg.runtime_path);
    const ffprobe = contained(vendor, platform.ffprobe.runtime_path);
    for (const [label, executable] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) {
      const { stdout } = await run(executable, ['-version']);
      const firstLine = stdout.split(/\r?\n/, 1)[0] ?? '';
      if (!firstLine.includes(descriptor.ffmpeg_version)) {
        throw new Error(`${label} version did not match ${descriptor.ffmpeg_version}: ${firstLine}`);
      }
    }

    process.stdout.write(`Video sidecar ${args.platform}: ${descriptor.ffmpeg_version} / ${descriptor.license}\n`);
  } finally {
    await rm(extract, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`prepare-video-sidecar: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
