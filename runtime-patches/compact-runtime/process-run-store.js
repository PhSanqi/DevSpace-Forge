import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pruneRunStore } from "./retention.js";
import { runStoreRoot } from "./run-store.js";
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export class ProcessRunLogger {
    runId;
    command;
    outputPath;
    root;
    cwd;
    workspaceRoot;
    startedAtMs;
    metaPath;
    fd;
    hash = createHash("sha256");
    bytes = 0;
    newlines = 0;
    lastByte = null;
    closed = false;
    writeError;
    constructor(input) {
        this.runId = input.runId;
        this.command = input.command;
        this.cwd = input.cwd;
        this.workspaceRoot = input.workspaceRoot;
        this.startedAtMs = input.startedAtMs;
        this.root = input.root;
        this.outputPath = input.outputPath;
        this.metaPath = input.metaPath;
        this.fd = input.fd;
    }
    static async create(input) {
        const startedAtMs = input.startedAtMs ?? Date.now();
        const started = new Date(startedAtMs);
        const root = input.root ?? runStoreRoot();
        const runId = `run_${started.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
        const runDir = path.join(root, started.toISOString().slice(0, 10), runId);
        await mkdir(runDir, { recursive: true, mode: 0o700 });
        const outputPath = path.join(runDir, "output.log");
        const metaPath = path.join(runDir, "meta.json");
        const fd = openSync(outputPath, "w", 0o600);
        return new ProcessRunLogger({ runId, command: input.command, cwd: input.cwd, workspaceRoot: input.workspaceRoot, startedAtMs, root, outputPath, metaPath, fd });
    }
    append(output) {
        if (!output || this.closed || this.writeError)
            return;
        const buffer = Buffer.from(output, "utf8");
        try {
            writeSync(this.fd, buffer, 0, buffer.length);
        }
        catch (error) {
            this.writeError = errorMessage(error);
            try { closeSync(this.fd); }
            catch { }
            this.closed = true;
            return;
        }
        this.hash.update(buffer);
        this.bytes += buffer.length;
        if (buffer.length > 0)
            this.lastByte = buffer[buffer.length - 1] ?? null;
        for (let index = 0; index < buffer.length; index += 1)
            if (buffer[index] === 0x0a)
                this.newlines += 1;
    }
    snapshot() {
        return { runId: this.runId, command: this.command, outputBytes: this.bytes, outputLines: this.bytes === 0 ? 0 : this.newlines + (this.lastByte === 0x0a ? 0 : 1), outputPath: this.outputPath, logError: this.writeError };
    }
    async finish(input) {
        if (!this.closed) {
            try { closeSync(this.fd); }
            catch (error) { this.writeError ??= errorMessage(error); }
            this.closed = true;
        }
        const finishedAtMs = Date.now();
        const snap = this.snapshot();
        const meta = {
            schemaVersion: 1, runId: this.runId, command: this.command, cwd: this.cwd, root: this.workspaceRoot,
            startedAt: new Date(this.startedAtMs).toISOString(), finishedAt: new Date(finishedAtMs).toISOString(),
            durationMs: Math.max(0, finishedAtMs - this.startedAtMs),
            isError: input.signal !== undefined || (input.exitCode ?? 0) !== 0,
            exitCode: input.exitCode ?? null, signal: input.signal ?? null, outputBytes: snap.outputBytes,
            outputLines: snap.outputLines, sha256: this.hash.digest("hex"), outputPath: this.outputPath,
            logError: this.writeError ?? null, recoveredUpstreamFullOutput: false, upstreamFullOutputPath: null
        };
        try { await writeFile(this.metaPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 }); }
        catch (error) { this.writeError ??= errorMessage(error); }
        try { await pruneRunStore({ root: this.root, now: finishedAtMs, protectRunId: this.runId }); }
        catch { }
        return { ...meta, logError: this.writeError ?? null };
    }
}
