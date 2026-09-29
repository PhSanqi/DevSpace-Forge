import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const PAYLOAD_CHUNK_BYTES = 48 * 1024;
export const PAYLOAD_READ_BYTES = 24 * 1024;
export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const DEFAULT_PAYLOAD_WORKSPACE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_PAYLOAD_TTL_MS = 24 * 60 * 60 * 1_000;
export const PAYLOAD_REF_PATTERN = /^payload_[a-f0-9]{24}$/;
export const PAYLOAD_SHA256_PATTERN = /^[a-f0-9]{64}$/;

interface PayloadManifest {
  schemaVersion: 1;
  payloadRef: string;
  workspaceId: string;
  operationId: string;
  totalBytes: number;
  sha256: string;
  chunkBytes: number;
  totalChunks: number;
  createdAt: number;
  updatedAt: number;
  committedAt?: number;
}

export interface PayloadStatus {
  payloadRef: string;
  totalBytes: number;
  sha256: string;
  chunkBytes: number;
  totalChunks: number;
  receivedSequences: number[];
  missingSequences: number[];
  committed: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PayloadSpoolOptions {
  maxPayloadBytes?: number;
  workspaceQuotaBytes?: number;
  ttlMs?: number;
  now?: () => number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function payloadRefFor(workspaceId: string, operationId: string): string {
  return `payload_${createHash("sha256")
    .update(workspaceId)
    .update("\0")
    .update(operationId)
    .digest("hex")
    .slice(0, 24)}`;
}

function workspaceKey(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 24);
}

function assertSha256(value: string): void {
  if (!PAYLOAD_SHA256_PATTERN.test(value)) {
    throw new Error("sha256 must be a lowercase 64-character SHA-256 hex digest.");
  }
}

function decodeCanonicalBase64(value: string): Buffer {
  if (
    value.length === 0
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("data_base64 must be canonical padded Base64.");
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.toString("base64") !== value) {
    throw new Error("data_base64 is not canonical Base64.");
  }
  return buffer;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class PayloadSpoolManager {
  private readonly root: string;
  private readonly maxPayloadBytes: number;
  private readonly workspaceQuotaBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(stateDir: string, options: PayloadSpoolOptions = {}) {
    this.root = path.join(stateDir, "payload-spool");
    this.maxPayloadBytes = positiveInteger(options.maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES);
    this.workspaceQuotaBytes = positiveInteger(
      options.workspaceQuotaBytes,
      DEFAULT_PAYLOAD_WORKSPACE_QUOTA_BYTES,
    );
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_PAYLOAD_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  async begin(input: {
    workspaceId: string;
    operationId: string;
    totalBytes: number;
    sha256: string;
  }): Promise<PayloadStatus> {
    if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes <= 0) {
      throw new Error("total_bytes must be a positive safe integer.");
    }
    if (input.totalBytes > this.maxPayloadBytes) {
      throw new Error(
        `Payload exceeds the ${this.maxPayloadBytes}-byte per-payload limit.`,
      );
    }
    assertSha256(input.sha256);
    const payloadRef = payloadRefFor(input.workspaceId, input.operationId);
    return this.withLock(`workspace:${input.workspaceId}`, async () => {
      const existing = await this.tryReadManifest(input.workspaceId, payloadRef);
      if (existing) {
        if (
          existing.operationId !== input.operationId
          || existing.totalBytes !== input.totalBytes
          || existing.sha256 !== input.sha256
        ) {
          throw new Error(
            `Payload ${payloadRef} already exists with different metadata.`,
          );
        }
        return this.statusFromManifest(existing);
      }
      const workspaceDir = this.workspaceDir(input.workspaceId);
      await mkdir(workspaceDir, { recursive: true, mode: 0o700 });
      const reserved = await this.pruneAndReservedBytes(input.workspaceId);
      if (reserved + input.totalBytes > this.workspaceQuotaBytes) {
        throw new Error(
          `Workspace payload quota exceeded: reserved ${reserved} + requested ${input.totalBytes} > ${this.workspaceQuotaBytes}.`,
        );
      }
      const now = this.now();
      const totalChunks = Math.ceil(input.totalBytes / PAYLOAD_CHUNK_BYTES);
      const manifest: PayloadManifest = {
        schemaVersion: 1,
        payloadRef,
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        totalBytes: input.totalBytes,
        sha256: input.sha256,
        chunkBytes: PAYLOAD_CHUNK_BYTES,
        totalChunks,
        createdAt: now,
        updatedAt: now,
      };
      const dir = this.payloadDir(input.workspaceId, payloadRef);
      await mkdir(path.join(dir, "chunks"), { recursive: true, mode: 0o700 });
      await writeFile(this.manifestPath(input.workspaceId, payloadRef), this.encodeManifest(manifest), {
        flag: "wx",
        mode: 0o600,
      });
      return this.statusFromManifest(manifest);
    });
  }

  async writeChunk(input: {
    workspaceId: string;
    payloadRef: string;
    sequence: number;
    sha256: string;
    dataBase64: string;
  }): Promise<{ replayed: boolean; status: PayloadStatus }> {
    assertSha256(input.sha256);
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
      throw new Error("sequence must be a non-negative safe integer.");
    }
    return this.withLock(this.lockKey(input.workspaceId, input.payloadRef), async () => {
      const manifest = await this.readManifest(input.workspaceId, input.payloadRef);
      if (manifest.committedAt !== undefined) {
        throw new Error(`Payload ${input.payloadRef} is already committed and immutable.`);
      }
      if (input.sequence >= manifest.totalChunks) {
        throw new Error(
          `Chunk sequence ${input.sequence} is outside 0..${manifest.totalChunks - 1}.`,
        );
      }
      const bytes = decodeCanonicalBase64(input.dataBase64);
      const expectedLength = this.expectedChunkLength(manifest, input.sequence);
      if (bytes.length !== expectedLength) {
        throw new Error(
          `Chunk ${input.sequence} has ${bytes.length} bytes; expected ${expectedLength}.`,
        );
      }
      const actualSha = createHash("sha256").update(bytes).digest("hex");
      if (actualSha !== input.sha256) {
        throw new Error(
          `Chunk ${input.sequence} SHA-256 mismatch: expected ${input.sha256}, got ${actualSha}.`,
        );
      }
      const target = this.chunkPath(input.workspaceId, input.payloadRef, input.sequence);
      if (await exists(target)) {
        const existing = await readFile(target);
        const existingSha = createHash("sha256").update(existing).digest("hex");
        if (existing.length !== bytes.length || existingSha !== actualSha) {
          throw new Error(
            `Chunk ${input.sequence} already exists with different content; refusing to overwrite.`,
          );
        }
        return {
          replayed: true,
          status: await this.statusFromManifest(manifest),
        };
      }
      const temp = `${target}.partial-${process.pid}-${this.now()}`;
      await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      await rename(temp, target);
      manifest.updatedAt = this.now();
      await this.writeManifest(manifest);
      return {
        replayed: false,
        status: await this.statusFromManifest(manifest),
      };
    });
  }

  async status(workspaceId: string, payloadRef: string): Promise<PayloadStatus> {
    const manifest = await this.readManifest(workspaceId, payloadRef);
    return this.statusFromManifest(manifest);
  }

  async commit(workspaceId: string, payloadRef: string): Promise<PayloadStatus> {
    return this.withLock(this.lockKey(workspaceId, payloadRef), async () => {
      const manifest = await this.readManifest(workspaceId, payloadRef);
      const finalPath = this.finalPath(workspaceId, payloadRef);
      if (manifest.committedAt !== undefined) {
        await this.verifyCommitted(manifest);
        return this.statusFromManifest(manifest);
      }
      const status = await this.statusFromManifest(manifest);
      if (status.missingSequences.length > 0) {
        throw new Error(
          `Payload ${payloadRef} is incomplete; missing chunk sequences: ${status.missingSequences.slice(0, 40).join(",")}${status.missingSequences.length > 40 ? ",…" : ""}.`,
        );
      }
      const temp = `${finalPath}.partial-${process.pid}-${this.now()}`;
      const handle = await open(temp, "wx", 0o600);
      const hash = createHash("sha256");
      let written = 0;
      try {
        for (let sequence = 0; sequence < manifest.totalChunks; sequence += 1) {
          const chunk = await readFile(this.chunkPath(workspaceId, payloadRef, sequence));
          const expectedLength = this.expectedChunkLength(manifest, sequence);
          if (chunk.length !== expectedLength) {
            throw new Error(
              `Chunk ${sequence} changed size before commit; expected ${expectedLength}, got ${chunk.length}.`,
            );
          }
          hash.update(chunk);
          await handle.write(chunk);
          written += chunk.length;
        }
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
      await handle.close();
      const digest = hash.digest("hex");
      if (written !== manifest.totalBytes || digest !== manifest.sha256) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw new Error(
          `Payload integrity mismatch at commit: bytes ${written}/${manifest.totalBytes}, sha256 ${digest}/${manifest.sha256}.`,
        );
      }
      await rename(temp, finalPath);
      manifest.committedAt = this.now();
      manifest.updatedAt = manifest.committedAt;
      await this.writeManifest(manifest);
      return this.statusFromManifest(manifest);
    });
  }

  async read(input: {
    workspaceId: string;
    payloadRef: string;
    offset?: number;
    length?: number;
    encoding?: "utf8" | "base64";
  }): Promise<{
    data: string;
    encoding: "utf8" | "base64";
    offset: number;
    length: number;
    totalBytes: number;
    eof: boolean;
    sha256: string;
  }> {
    const manifest = await this.readManifest(input.workspaceId, input.payloadRef);
    if (manifest.committedAt === undefined) {
      throw new Error(`Payload ${input.payloadRef} is not committed.`);
    }
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const requested = Math.max(1, Math.floor(input.length ?? PAYLOAD_READ_BYTES));
    const length = Math.min(requested, PAYLOAD_READ_BYTES);
    if (offset > manifest.totalBytes) {
      throw new Error(`offset ${offset} exceeds payload size ${manifest.totalBytes}.`);
    }
    const buffer = Buffer.alloc(Math.min(length, manifest.totalBytes - offset));
    const handle = await open(this.finalPath(input.workspaceId, input.payloadRef), "r");
    let bytesRead = 0;
    try {
      if (buffer.length > 0) {
        ({ bytesRead } = await handle.read(buffer, 0, buffer.length, offset));
      }
    } finally {
      await handle.close();
    }
    const slice = buffer.subarray(0, bytesRead);
    const encoding = input.encoding ?? "utf8";
    return {
      data: encoding === "base64" ? slice.toString("base64") : slice.toString("utf8"),
      encoding,
      offset,
      length: bytesRead,
      totalBytes: manifest.totalBytes,
      eof: offset + bytesRead >= manifest.totalBytes,
      sha256: manifest.sha256,
    };
  }

  async resolveText(workspaceId: string, payloadRef: string): Promise<string> {
    const manifest = await this.readManifest(workspaceId, payloadRef);
    if (manifest.committedAt === undefined) {
      throw new Error(`Payload ${payloadRef} is not committed.`);
    }
    const bytes = await readFile(this.finalPath(workspaceId, payloadRef));
    if (bytes.length !== manifest.totalBytes) {
      throw new Error(`Payload ${payloadRef} size no longer matches its committed manifest.`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== manifest.sha256) {
      throw new Error(`Payload ${payloadRef} SHA-256 no longer matches its committed manifest.`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Payload ${payloadRef} is not valid UTF-8 text.`);
    }
  }

  private async statusFromManifest(manifest: PayloadManifest): Promise<PayloadStatus> {
    const chunksDir = path.join(
      this.payloadDir(manifest.workspaceId, manifest.payloadRef),
      "chunks",
    );
    let entries: string[] = [];
    try {
      entries = await readdir(chunksDir);
    } catch {
      // An empty/missing chunk directory is equivalent to receiving nothing.
    }
    const receivedSequences = entries
      .map((name) => /^(\d{8})\.part$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number.parseInt(match[1]!, 10))
      .filter((sequence) => sequence >= 0 && sequence < manifest.totalChunks)
      .sort((left, right) => left - right);
    const received = new Set(receivedSequences);
    const missingSequences: number[] = [];
    for (let sequence = 0; sequence < manifest.totalChunks; sequence += 1) {
      if (!received.has(sequence)) missingSequences.push(sequence);
    }
    return {
      payloadRef: manifest.payloadRef,
      totalBytes: manifest.totalBytes,
      sha256: manifest.sha256,
      chunkBytes: manifest.chunkBytes,
      totalChunks: manifest.totalChunks,
      receivedSequences,
      missingSequences,
      committed: manifest.committedAt !== undefined,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    };
  }

  private async verifyCommitted(manifest: PayloadManifest): Promise<void> {
    const info = await stat(this.finalPath(manifest.workspaceId, manifest.payloadRef));
    if (info.size !== manifest.totalBytes) {
      throw new Error(`Committed payload ${manifest.payloadRef} size mismatch.`);
    }
  }

  private expectedChunkLength(manifest: PayloadManifest, sequence: number): number {
    const start = sequence * manifest.chunkBytes;
    return Math.min(manifest.chunkBytes, manifest.totalBytes - start);
  }

  private workspaceDir(workspaceId: string): string {
    return path.join(this.root, `workspace-${workspaceKey(workspaceId)}`);
  }

  private payloadDir(workspaceId: string, payloadRef: string): string {
    if (!PAYLOAD_REF_PATTERN.test(payloadRef)) {
      throw new Error("Invalid payload_ref.");
    }
    return path.join(this.workspaceDir(workspaceId), payloadRef);
  }

  private manifestPath(workspaceId: string, payloadRef: string): string {
    return path.join(this.payloadDir(workspaceId, payloadRef), "manifest.json");
  }

  private finalPath(workspaceId: string, payloadRef: string): string {
    return path.join(this.payloadDir(workspaceId, payloadRef), "payload.bin");
  }

  private chunkPath(workspaceId: string, payloadRef: string, sequence: number): string {
    return path.join(
      this.payloadDir(workspaceId, payloadRef),
      "chunks",
      `${sequence.toString().padStart(8, "0")}.part`,
    );
  }

  private lockKey(workspaceId: string, payloadRef: string): string {
    return `${workspaceId}\0${payloadRef}`;
  }

  private async readManifest(workspaceId: string, payloadRef: string): Promise<PayloadManifest> {
    const manifest = await this.tryReadManifest(workspaceId, payloadRef);
    if (!manifest) throw new Error(`Unknown payload_ref ${payloadRef} for this workspace.`);
    return manifest;
  }

  private async tryReadManifest(
    workspaceId: string,
    payloadRef: string,
  ): Promise<PayloadManifest | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(this.manifestPath(workspaceId, payloadRef), "utf8"),
      ) as PayloadManifest;
      if (
        parsed.schemaVersion !== 1
        || parsed.workspaceId !== workspaceId
        || parsed.payloadRef !== payloadRef
      ) {
        throw new Error(`Payload manifest ${payloadRef} does not belong to this workspace.`);
      }
      return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeManifest(manifest: PayloadManifest): Promise<void> {
    const target = this.manifestPath(manifest.workspaceId, manifest.payloadRef);
    const temp = `${target}.partial-${process.pid}`;
    await writeFile(temp, this.encodeManifest(manifest), { mode: 0o600 });
    await rename(temp, target);
  }

  private encodeManifest(manifest: PayloadManifest): string {
    return `${JSON.stringify(manifest, null, 2)}\n`;
  }

  private async pruneAndReservedBytes(workspaceId: string): Promise<number> {
    const dir = this.workspaceDir(workspaceId);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let reserved = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !PAYLOAD_REF_PATTERN.test(entry.name)) continue;
      let manifest: PayloadManifest | undefined;
      try {
        manifest = await this.tryReadManifest(workspaceId, entry.name);
      } catch {
        continue;
      }
      if (!manifest) continue;
      if (this.now() - manifest.updatedAt > this.ttlMs) {
        await rm(this.payloadDir(workspaceId, entry.name), { recursive: true, force: true });
        continue;
      }
      reserved += manifest.totalBytes;
    }
    return reserved;
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => hold);
    this.locks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

const payloadSpools = new Map<string, PayloadSpoolManager>();

export function payloadSpoolManager(stateDir: string): PayloadSpoolManager {
  const key = path.resolve(stateDir);
  let manager = payloadSpools.get(key);
  if (!manager) {
    manager = new PayloadSpoolManager(key);
    payloadSpools.set(key, manager);
  }
  return manager;
}
