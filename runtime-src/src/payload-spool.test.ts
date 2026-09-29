import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PAYLOAD_CHUNK_BYTES,
  PayloadSpoolManager,
} from "./payload-spool.js";

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("payload spool uploads, resumes, commits, and reads an immutable payload", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "devspace-payload-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const bytes = Buffer.concat([
    Buffer.alloc(PAYLOAD_CHUNK_BYTES, "a"),
    Buffer.from("tail-data"),
  ]);
  const manager = new PayloadSpoolManager(stateDir);
  const begun = await manager.begin({
    workspaceId: "ws_alpha",
    operationId: "payload.begin.alpha",
    totalBytes: bytes.length,
    sha256: sha(bytes),
  });
  assert.equal(begun.totalChunks, 2);
  assert.deepEqual(begun.missingSequences, [0, 1]);

  const first = bytes.subarray(0, PAYLOAD_CHUNK_BYTES);
  const second = bytes.subarray(PAYLOAD_CHUNK_BYTES);
  const uploaded0 = await manager.writeChunk({
    workspaceId: "ws_alpha",
    payloadRef: begun.payloadRef,
    sequence: 0,
    sha256: sha(first),
    dataBase64: first.toString("base64"),
  });
  assert.equal(uploaded0.replayed, false);
  const replayed0 = await manager.writeChunk({
    workspaceId: "ws_alpha",
    payloadRef: begun.payloadRef,
    sequence: 0,
    sha256: sha(first),
    dataBase64: first.toString("base64"),
  });
  assert.equal(replayed0.replayed, true);
  await assert.rejects(
    manager.writeChunk({
      workspaceId: "ws_alpha",
      payloadRef: begun.payloadRef,
      sequence: 0,
      sha256: sha(Buffer.alloc(first.length, "b")),
      dataBase64: Buffer.alloc(first.length, "b").toString("base64"),
    }),
    /different content/,
  );
  await assert.rejects(
    manager.commit("ws_alpha", begun.payloadRef),
    /missing chunk sequences: 1/,
  );

  await manager.writeChunk({
    workspaceId: "ws_alpha",
    payloadRef: begun.payloadRef,
    sequence: 1,
    sha256: sha(second),
    dataBase64: second.toString("base64"),
  });
  const committed = await manager.commit("ws_alpha", begun.payloadRef);
  assert.equal(committed.committed, true);
  assert.deepEqual(committed.missingSequences, []);
  assert.equal(await manager.resolveText("ws_alpha", begun.payloadRef), bytes.toString("utf8"));

  const segment = await manager.read({
    workspaceId: "ws_alpha",
    payloadRef: begun.payloadRef,
    offset: PAYLOAD_CHUNK_BYTES - 2,
    length: 8,
    encoding: "base64",
  });
  assert.equal(Buffer.from(segment.data, "base64").toString("utf8"), "aatail-d");
  assert.equal(segment.length, 8);
  assert.equal(segment.eof, false);
  await assert.rejects(
    manager.writeChunk({
      workspaceId: "ws_alpha",
      payloadRef: begun.payloadRef,
      sequence: 1,
      sha256: sha(second),
      dataBase64: second.toString("base64"),
    }),
    /already committed and immutable/,
  );
});

test("payload spool survives manager restart and stays workspace scoped", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "devspace-payload-resume-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const bytes = Buffer.from("resume after disconnect");
  const first = new PayloadSpoolManager(stateDir);
  const begun = await first.begin({
    workspaceId: "ws_resume",
    operationId: "payload.begin.resume",
    totalBytes: bytes.length,
    sha256: sha(bytes),
  });
  await first.writeChunk({
    workspaceId: "ws_resume",
    payloadRef: begun.payloadRef,
    sequence: 0,
    sha256: sha(bytes),
    dataBase64: bytes.toString("base64"),
  });

  const restarted = new PayloadSpoolManager(stateDir);
  const status = await restarted.status("ws_resume", begun.payloadRef);
  assert.deepEqual(status.receivedSequences, [0]);
  assert.equal((await restarted.commit("ws_resume", begun.payloadRef)).committed, true);
  await assert.rejects(
    restarted.status("ws_other", begun.payloadRef),
    /Unknown payload_ref/,
  );
});

test("payload begin is deterministic and conflicting metadata fails closed", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "devspace-payload-begin-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const manager = new PayloadSpoolManager(stateDir);
  const bytes = Buffer.from("same request");
  const input = {
    workspaceId: "ws_same",
    operationId: "payload.begin.same",
    totalBytes: bytes.length,
    sha256: sha(bytes),
  };
  const first = await manager.begin(input);
  const second = await manager.begin(input);
  assert.equal(second.payloadRef, first.payloadRef);
  await assert.rejects(
    manager.begin({ ...input, totalBytes: bytes.length + 1 }),
    /different metadata/,
  );
});

test("payload quota rejects overcommit and expired reservations are pruned", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "devspace-payload-quota-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let now = 1_000;
  const manager = new PayloadSpoolManager(stateDir, {
    maxPayloadBytes: 10,
    workspaceQuotaBytes: 10,
    ttlMs: 100,
    now: () => now,
  });
  const a = Buffer.from("12345678");
  await manager.begin({
    workspaceId: "ws_quota",
    operationId: "payload.begin.quota-a",
    totalBytes: a.length,
    sha256: sha(a),
  });
  const b = Buffer.from("abcd");
  await assert.rejects(
    manager.begin({
      workspaceId: "ws_quota",
      operationId: "payload.begin.quota-b",
      totalBytes: b.length,
      sha256: sha(b),
    }),
    /quota exceeded/,
  );
  now += 101;
  const afterExpiry = await manager.begin({
    workspaceId: "ws_quota",
    operationId: "payload.begin.quota-b",
    totalBytes: b.length,
    sha256: sha(b),
  });
  assert.equal(afterExpiry.totalBytes, 4);
});

test("payload chunks require canonical Base64 and declared SHA-256", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "devspace-payload-base64-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const bytes = Buffer.from("abc");
  const manager = new PayloadSpoolManager(stateDir);
  const begun = await manager.begin({
    workspaceId: "ws_b64",
    operationId: "payload.begin.base64",
    totalBytes: bytes.length,
    sha256: sha(bytes),
  });
  await assert.rejects(
    manager.writeChunk({
      workspaceId: "ws_b64",
      payloadRef: begun.payloadRef,
      sequence: 0,
      sha256: sha(bytes),
      dataBase64: "not base64",
    }),
    /canonical padded Base64/,
  );
  await assert.rejects(
    manager.writeChunk({
      workspaceId: "ws_b64",
      payloadRef: begun.payloadRef,
      sequence: 0,
      sha256: "0".repeat(64),
      dataBase64: bytes.toString("base64"),
    }),
    /SHA-256 mismatch/,
  );
});
