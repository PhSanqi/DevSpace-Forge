import { createReadStream } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import readline from "node:readline";
import path from "node:path";
import { runStoreRoot } from "./run-store.js";
const RUN_RE = /^run_[A-Za-z0-9_]+$/;
const MAX_LINES = 500;
const MAX_MATCHES = 200;
const MAX_RETURN_CHARS = 20000;
const MAX_BYTE_READ = 32 * 1024;
async function findRunDir(runId) {
    if (!RUN_RE.test(runId)) throw new Error("invalid runId");
    const root = runStoreRoot();
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch { throw new Error(`run not found: ${runId}`); }
    const days = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    for (const day of days) {
        const candidate = path.join(root, day, runId);
        try {
            const files = await readdir(candidate);
            if (files.includes("output.log") || files.includes("meta.json")) return candidate;
        }
        catch { }
    }
    throw new Error(`run not found: ${runId}`);
}
function boundedCount(value, fallback, max = MAX_LINES) {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), max) : fallback;
}
function appendBounded(lines, line, state) {
    if (state.chars >= MAX_RETURN_CHARS) return false;
    const remaining = MAX_RETURN_CHARS - state.chars;
    const clipped = line.length > remaining ? line.slice(0, remaining) : line;
    lines.push(clipped);
    state.chars += clipped.length + 1;
    if (clipped.length < line.length || state.chars >= MAX_RETURN_CHARS) {
        lines.push("… [model view capped; use devspace-log bytes for the raw range]");
        state.chars = MAX_RETURN_CHARS;
        return false;
    }
    return true;
}
async function streamReadLines(filePath, start, count) {
    const lines = [], state = { chars: 0 }, input = createReadStream(filePath, { encoding: "utf8" });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    let lineNo = 0;
    try { for await (const line of reader) { lineNo += 1; if (lineNo < start) continue; if (lineNo >= start + count) break; if (!appendBounded(lines, line, state)) break; } }
    finally { reader.close(); input.destroy(); }
    return lines.length ? lines.join("\n") : `(no lines at ${start})`;
}
async function streamTail(filePath, count) {
    const ring = [], input = createReadStream(filePath, { encoding: "utf8" });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    try { for await (const line of reader) { ring.push(line.length > MAX_RETURN_CHARS ? `${line.slice(0, MAX_RETURN_CHARS)}…` : line); if (ring.length > count) ring.shift(); } }
    finally { reader.close(); input.destroy(); }
    const state = { chars: 0 }, lines = [];
    for (const line of ring) if (!appendBounded(lines, line, state)) break;
    return lines.length ? lines.join("\n") : "(empty log)";
}
async function streamGrep(filePath, pattern) {
    const needle = pattern.toLowerCase(), matches = [], state = { chars: 0 }, input = createReadStream(filePath, { encoding: "utf8" });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    try { for await (const line of reader) { if (!line.toLowerCase().includes(needle)) continue; if (!appendBounded(matches, line, state) || matches.length >= MAX_MATCHES) break; } }
    finally { reader.close(); input.destroy(); }
    return matches.length ? matches.join("\n") : `(no matches for ${pattern})`;
}
async function readBytes(filePath, offsetValue, lengthValue) {
    const parsedOffset = Number.parseInt(offsetValue ?? "0", 10), parsedLength = Number.parseInt(lengthValue ?? `${MAX_BYTE_READ}`, 10);
    const offset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0;
    const length = Number.isFinite(parsedLength) ? Math.min(Math.max(parsedLength, 1), MAX_BYTE_READ) : MAX_BYTE_READ;
    const handle = await open(filePath, "r");
    try { const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, offset); return buffer.subarray(0, bytesRead).toString("utf8"); }
    finally { await handle.close(); }
}
export async function handleRunLogCommand(command) {
    const parts = command.trim().split(/\s+/);
    if (parts[0] !== "devspace-log") return null;
    const action = parts[1], runId = parts[2];
    if (!action || !runId) throw new Error("usage: devspace-log read|tail|grep|bytes|meta <runId> ...");
    const runDir = await findRunDir(runId), outputPath = path.join(runDir, "output.log");
    if (action === "meta") {
        try { return (await readFile(path.join(runDir, "meta.json"), "utf8")).trimEnd(); }
        catch { const info = await stat(outputPath); return JSON.stringify({ schemaVersion: 1, runId, running: true, outputBytes: info.size }, null, 2); }
    }
    if (action === "tail") return streamTail(outputPath, boundedCount(parts[3], 80));
    if (action === "read") return streamReadLines(outputPath, boundedCount(parts[3], 1, Number.MAX_SAFE_INTEGER), boundedCount(parts[4], 80));
    if (action === "grep") { const pattern = parts.slice(3).join(" "); if (!pattern) throw new Error("usage: devspace-log grep <runId> <pattern>"); return streamGrep(outputPath, pattern); }
    if (action === "bytes") return readBytes(outputPath, parts[3], parts[4]);
    throw new Error(`unknown devspace-log action: ${action}`);
}
