import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireSwitchGate, readSwitchGateOwner, reclaimLegacyOwnerlessGate, recoverSwitchGate, releaseSwitchGate, sweepSwitchGateDebris } from "./runtime-switch-gate.js";
import { DurableJobManager } from "./durable-jobs.js";
import { processStartIdentity } from "./process-platform.js";
// Exercise the independently shipped guard against the Runtime protocol.
// @ts-expect-error The JavaScript guard ships without TypeScript declarations.
import { withRuntimeRestartGuard } from "../../ops/runtime-jobs-guard.mjs";

function fixture(t: test.TestContext) {
  const state = mkdtempSync(join(tmpdir(), "devspace-switch-protocol-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  return { state, gate: join(state, ".runtime-switch-gate") };
}

test("switch gate ignores unpublished crash debris and releases atomically", (t) => {
  const { gate } = fixture(t);
  mkdirSync(`${gate}.tmp-interrupted`);
  const nonce = acquireSwitchGate(gate, null);
  assert.ok(nonce);
  assert.equal(readSwitchGateOwner(gate).nonce, nonce);
  assert.equal(acquireSwitchGate(gate, null), null);
  releaseSwitchGate(gate, "another-owner");
  assert.ok(existsSync(gate));
  releaseSwitchGate(gate, nonce);
  assert.equal(existsSync(gate), false);
  assert.ok(acquireSwitchGate(gate, null));
});

test("switch gate keeps empty and invalid legacy owners blocking", (t) => {
  const { gate } = fixture(t);
  mkdirSync(gate);
  assert.equal(acquireSwitchGate(gate, null), null);
  writeFileSync(join(gate, "owner.json"), "invalid");
  assert.equal(acquireSwitchGate(gate, null), null);
});

test("switch gate reclaims only aged legacy ownerless gates", (t) => {
  const { state } = fixture(t);
  const now = Date.now() + 11 * 60_000;
  const warnings = t.mock.method(console, "warn", () => {});

  const empty = join(state, ".empty-gate");
  mkdirSync(empty);
  assert.equal(reclaimLegacyOwnerlessGate(empty, now), true);
  assert.equal(existsSync(empty), false);
  const nonce = acquireSwitchGate(empty, null);
  assert.ok(nonce, "a reclaimed gate can be acquired");
  releaseSwitchGate(empty, nonce);

  for (const [name, contents] of [["zero", ""], ["truncated", '{"pid":']] as const) {
    const gate = join(state, `.${name}-gate`);
    mkdirSync(gate);
    writeFileSync(join(gate, "owner.json"), contents);
    assert.equal(reclaimLegacyOwnerlessGate(gate, now), true, `${name} owner is reclaimed`);
    assert.equal(existsSync(gate), false);
  }

  const invalid = join(state, ".invalid-owner-gate");
  mkdirSync(invalid);
  writeFileSync(join(invalid, "owner.json"), '{"foo":1}');
  assert.equal(reclaimLegacyOwnerlessGate(invalid, now), false, "parseable invalid owner stays blocking");
  assert.ok(existsSync(invalid));

  const bom = join(state, ".bom-owner-gate");
  mkdirSync(bom);
  writeFileSync(join(bom, "owner.json"), '\uFEFF{"pid":1,"processStartIdentity":null,"createdAt":1,"nonce":"n"}');
  assert.equal(reclaimLegacyOwnerlessGate(bom, now), false, "a BOM-prefixed owner stays blocking");
  assert.ok(existsSync(bom));

  const extra = join(state, ".extra-entry-gate");
  mkdirSync(extra);
  writeFileSync(join(extra, "notes.txt"), "x");
  assert.equal(reclaimLegacyOwnerlessGate(extra, now), false, "an extra entry stays blocking");
  assert.ok(existsSync(extra));

  const fresh = join(state, ".fresh-gate");
  mkdirSync(fresh);
  assert.equal(reclaimLegacyOwnerlessGate(fresh), false, "a fresh ownerless gate stays blocking");
  assert.ok(existsSync(fresh));

  assert.equal(warnings.mock.callCount(), 3);
});

test("switch gate leaves a symlinked gate blocking", { skip: process.platform === "win32" }, (t) => {
  const { state, gate } = fixture(t);
  const target = join(state, "gate-target");
  mkdirSync(target);
  symlinkSync(target, gate, "dir");
  assert.equal(reclaimLegacyOwnerlessGate(gate, Date.now() + 11 * 60_000), false);
  assert.ok(existsSync(gate));
  assert.ok(existsSync(target));
});

test("switch gate release retries transient rename failures and removes its owner in place after five failures", (t) => {
  const { gate } = fixture(t);
  const warnings = t.mock.method(console, "warn", () => {});
  for (const failures of [2, 5]) {
    const nonce = acquireSwitchGate(gate, "synthetic");
    assert.ok(nonce);
    let attempts = 0;
    releaseSwitchGate(gate, nonce, (source, destination) => {
      if (++attempts <= failures) throw Object.assign(new Error("synthetic handle contention"), { code: "EBUSY" });
      renameSync(source, destination);
    });
    assert.equal(attempts, failures === 5 ? 5 : 3);
    assert.equal(existsSync(gate), false);
    const next = acquireSwitchGate(gate, "next");
    assert.ok(next, "a completed release must free the gate immediately");
    releaseSwitchGate(gate, next);
  }
  assert.equal(warnings.mock.callCount(), 1);
});

test("switch gate release stops retrying when a different owner acquires the gate", (t) => {
  const { gate } = fixture(t);
  const nonce = acquireSwitchGate(gate, "old");
  assert.ok(nonce);
  let attempts = 0;
  let next: string | null = null;
  releaseSwitchGate(gate, nonce, () => {
    attempts++;
    releaseSwitchGate(gate, nonce);
    next = acquireSwitchGate(gate, "new");
    throw new Error("synthetic ownership change");
  });
  assert.equal(attempts, 1);
  assert.equal(readSwitchGateOwner(gate).nonce, next);
});

test("macOS guard and Runtime use the same process start identity", { skip: process.platform !== "darwin" }, async (t) => {
  const { state, gate } = fixture(t);
  await withRuntimeRestartGuard({ stateDir: state }, () => {
    assert.ok(processStartIdentity(process.pid));
    assert.equal(readSwitchGateOwner(gate).processStartIdentity, processStartIdentity(process.pid));
    return { ok: true };
  });
});

test("switch gate stale recovery restores a re-acquired owner without abandoned-job mutation", (t) => {
  const { gate } = fixture(t);
  const nonce = acquireSwitchGate(gate, "old");
  assert.ok(nonce);
  const staleOwner = readSwitchGateOwner(gate);
  let updated = false;
  const recovered = recoverSwitchGate(gate, staleOwner, () => { updated = true; }, (source, destination) => {
    releaseSwitchGate(gate, nonce);
    assert.ok(acquireSwitchGate(gate, "new"));
    renameSync(source, destination);
  });
  assert.equal(recovered, false);
  assert.equal(updated, false);
  assert.equal(readSwitchGateOwner(gate).processStartIdentity, "new");
});

test("switch gate stale recovery preserves displaced owner when restoration is blocked", (t) => {
  const { state, gate } = fixture(t);
  const nonce = acquireSwitchGate(gate, "old");
  assert.ok(nonce);
  const staleOwner = readSwitchGateOwner(gate);
  const recovered = recoverSwitchGate(gate, staleOwner, () => assert.fail("must not update"), (source, destination) => {
    releaseSwitchGate(gate, nonce);
    assert.ok(acquireSwitchGate(gate, "displaced"));
    renameSync(source, destination);
    assert.ok(acquireSwitchGate(gate, "current"));
  });
  assert.equal(recovered, false);
  assert.equal(readSwitchGateOwner(gate).processStartIdentity, "current");
  const saved = readdirSync(state).find(name => name.startsWith(".runtime-switch-gate.stale-"));
  assert.ok(saved);
  assert.equal(readSwitchGateOwner(join(state, saved)).processStartIdentity, "displaced");
});

test("switch gate sweeps only protocol debris older than ten minutes", (t) => {
  const { state, gate } = fixture(t);
  for (const suffix of [".tmp-dead", ".released-dead", ".stale-dead", ".unrelated"]) mkdirSync(gate + suffix);
  mkdirSync(gate);
  sweepSwitchGateDebris(gate);
  assert.equal(readdirSync(state).length, 5);
  sweepSwitchGateDebris(gate, Date.now() + 11 * 60_000);
  assert.deepEqual(readdirSync(state).sort(), [".runtime-switch-gate", ".runtime-switch-gate.unrelated"]);
});

test("guard and Runtime job launch cannot hold the switch gate together", async (t) => {
  const { state, gate } = fixture(t);
  await withRuntimeRestartGuard({ stateDir: state }, async () => {
    const owner = readSwitchGateOwner(gate);
    assert.ok(owner.nonce);
    const manager = new DurableJobManager(state);
    try {
      const record = manager.startJob({ workspaceId: "test", workspaceRoot: state, workingDirectory: state, command: "echo forbidden" });
      assert.equal(record.status, "failed");
      assert.match(record.error ?? "", /switch gate/);
      assert.equal(readSwitchGateOwner(gate).nonce, owner.nonce);
    } finally { manager.close(); }
    return { ok: true };
  });
  assert.equal(existsSync(gate), false);
  const nonce = acquireSwitchGate(gate, null);
  assert.ok(nonce);
  const result = await withRuntimeRestartGuard({ stateDir: state }, () => assert.fail("must not enter"));
  assert.equal(result.reason_code, "runtime_switch_in_progress");
  releaseSwitchGate(gate, nonce);
});

test("Windows rename cannot replace existing empty or populated gate", { skip: process.platform !== "win32" }, (t) => {
  const { gate } = fixture(t);
  for (const populated of [false, true]) {
    const source = `${gate}.tmp-windows`;
    mkdirSync(source);
    writeFileSync(join(source, "owner.json"), "new");
    mkdirSync(gate);
    if (populated) writeFileSync(join(gate, "owner.json"), "existing");
    assert.throws(() => renameSync(source, gate));
    assert.ok(existsSync(source));
    if (populated) assert.equal(readFileSync(join(gate, "owner.json"), "utf8"), "existing");
    rmSync(source, { recursive: true });
    rmSync(gate, { recursive: true });
  }
});
