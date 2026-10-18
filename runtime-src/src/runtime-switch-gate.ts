import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

interface GateOwner {
  pid: number;
  processStartIdentity: string | null;
  createdAt: number;
  nonce?: string; // Older Runtime owners did not have a nonce.
}

export function readSwitchGateOwner(gate: string): GateOwner {
  const owner = JSON.parse(readFileSync(join(gate, "owner.json"), "utf8")) as GateOwner;
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !Number.isFinite(owner.createdAt) ||
      !(owner.processStartIdentity === null || typeof owner.processStartIdentity === "string") ||
      !(owner.nonce === undefined || typeof owner.nonce === "string")) throw new Error("Invalid switch gate owner");
  return owner;
}

// Keep the publish/release protocol in sync with ops/runtime-jobs-guard.mjs.
export function acquireSwitchGate(gate: string, identity: string | null): string | null {
  const nonce = randomUUID();
  const temp = `${gate}.tmp-${process.pid}-${nonce}`;
  try {
    mkdirSync(temp, { mode: 0o700 });
    const fd = openSync(join(temp, "owner.json"), "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, processStartIdentity: identity, createdAt: Date.now(), nonce }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    // POSIX rename replaces an empty directory. Legacy ownerless gates block;
    // all Node publishers use populated directories before atomic publication.
    if (existsSync(gate)) return null;
    renameSync(temp, gate);
    return readSwitchGateOwner(gate).nonce === nonce ? nonce : null;
  } catch { return null; }
  finally { rmSync(temp, { recursive: true, force: true }); }
}

export function releaseSwitchGate(gate: string, nonce: string, move = renameSync): void {
  const released = `${gate}.released-${randomUUID()}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { if (readSwitchGateOwner(gate).nonce !== nonce) return; }
    catch { return; } // An uncertain owner must remain blocking.
    try { move(gate, released); break; }
    catch {
      if (attempt < 4) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
        continue;
      }
      console.warn("Runtime switch gate release rename failed; removing the owned gate in place.");
      try {
        if (readSwitchGateOwner(gate).nonce !== nonce) return;
        unlinkSync(join(gate, "owner.json"));
        rmdirSync(gate);
      } catch { console.warn("Runtime switch gate in-place release failed."); }
      return;
    }
  }
  try { rmSync(released, { recursive: true, force: true }); }
  catch { console.warn("Runtime switch gate released; debris removal failed."); }
}

export function recoverSwitchGate(
  gate: string, owner: GateOwner, recover: () => void, move = renameSync,
): boolean {
  const stale = `${gate}.stale-${randomUUID()}`;
  try {
    move(gate, stale);
    const moved = readSwitchGateOwner(stale);
    if (moved.nonce !== owner.nonce || moved.pid !== owner.pid || moved.createdAt !== owner.createdAt ||
        moved.processStartIdentity !== owner.processStartIdentity) {
      try { if (!existsSync(gate)) renameSync(stale, gate); } catch {}
      return false;
    }
    recover();
    rmSync(stale, { recursive: true, force: true });
    return true;
  } catch {
    try { if (!existsSync(gate)) renameSync(stale, gate); } catch {}
    return false;
  }
}

export function sweepSwitchGateDebris(gate: string, now = Date.now()): void {
  try {
    const prefix = basename(gate);
    for (const name of readdirSync(dirname(gate))) {
      if (![".tmp-", ".released-", ".stale-"].some(suffix => name.startsWith(prefix + suffix))) continue;
      const sibling = join(dirname(gate), name);
      try {
        const info = statSync(sibling);
        if (Math.max(info.mtimeMs, info.ctimeMs) < now - 10 * 60_000) rmSync(sibling, { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}
