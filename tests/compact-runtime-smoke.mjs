import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const packageRoot = process.env.DEVSPACE_TEST_PACKAGE_ROOT
    ? path.resolve(process.env.DEVSPACE_TEST_PACKAGE_ROOT)
    : path.join(projectRoot, "runtime", "devspace", "node_modules", "@waishnav", "devspace");
const runtimeDist = path.join(packageRoot, "dist");
const runRoot = await mkdtemp(path.join(tmpdir(), "devspace-compact-smoke-"));
process.env.DEVSPACE_COMPACT_RUN_ROOT = runRoot;

try {
    const { ProcessSessionManager } = await import(pathToFileURL(path.join(runtimeDist, "process-sessions.js")));
    const { compactPreview, commandClass } = await import(pathToFileURL(path.join(runtimeDist, "compact-runtime", "output-policy.js")));
    const { handleRunLogCommand } = await import(pathToFileURL(path.join(runtimeDist, "compact-runtime", "run-log-access.js")));
    const runLog = (command) => handleRunLogCommand.length >= 2
        ? handleRunLogCommand(command, runRoot)
        : handleRunLogCommand(command);
    const manager = new ProcessSessionManager({ maxBufferCharacters: 512, runRoot });
    const command = 'for /L %i in (1,1,30000) do @echo ROW-%i';
    const snapshot = await manager.start({
        workspaceId: "smoke",
        workspaceRoot: projectRoot,
        cwd: projectRoot,
        command,
        yieldTimeMs: 30000,
        maxOutputTokens: 100000,
    });

    assert.equal(snapshot.running, false);
    assert.equal(snapshot.exitCode, 0);
    assert.match(snapshot.runId, /^run_[A-Za-z0-9_]+$/);
    assert.ok(snapshot.outputBytes > 250000, `expected full output bytes, got ${snapshot.outputBytes}`);
    assert.equal(snapshot.outputTruncated, true);
    assert.ok(snapshot.output.length < 1000, `head/tail buffer was not bounded: ${snapshot.output.length}`);

    const metaText = await runLog(`devspace-log meta ${snapshot.runId}`);
    const meta = JSON.parse(metaText);
    assert.equal(meta.outputBytes, snapshot.outputBytes);
    const dayMatch = /^run_(\d{4})(\d{2})(\d{2})/.exec(snapshot.runId);
    const managedOutputPath = meta.outputPath ?? (dayMatch
        ? path.join(runRoot, `${dayMatch[1]}-${dayMatch[2]}-${dayMatch[3]}`, snapshot.runId, "output.log")
        : undefined);
    assert.ok(managedOutputPath, `unable to resolve local output path for ${snapshot.runId}`);
    assert.equal((await stat(managedOutputPath)).size, snapshot.outputBytes);
    assert.equal((await readFile(managedOutputPath, "utf8")).includes("ROW-30000"), true);

    const tail = await runLog(`devspace-log tail ${snapshot.runId} 3`);
    assert.match(tail, /ROW-30000/);
    const found = await runLog(`devspace-log grep ${snapshot.runId} ROW-29999`);
    assert.match(found, /ROW-29999/);
    assert.equal(commandClass("git status"), "inspection");
    assert.ok(compactPreview("x".repeat(10000), false, "npm run build").length <= 705);

    const running = await manager.start({
        workspaceId: "status-smoke",
        workspaceRoot: projectRoot,
        cwd: projectRoot,
        command: 'powershell -NoProfile -Command "Start-Sleep -Milliseconds 750"',
        yieldTimeMs: 25,
        maxOutputTokens: 1000,
    });
    assert.equal(running.running, true);
    assert.equal(typeof running.sessionId, "number");
    if (typeof manager.status === "function") {
        const status = manager.status("status-smoke", running.sessionId);
        assert.equal(status.runId, running.runId);
        assert.equal(status.running, true);
        assert.ok(status.wallTimeMs >= 0);
    }
    else {
        assert.equal(running.running, true);
        assert.equal(typeof running.sessionId, "number");
        assert.ok(running.wallTimeMs >= 0);
    }
    let finished = running;
    for (let attempt = 0; attempt < 20 && finished.running; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 75));
        finished = await manager.write({
            workspaceId: "status-smoke",
            sessionId: running.sessionId,
            yieldTimeMs: 25,
            maxOutputTokens: 1000,
        });
    }
    assert.equal(finished.running, false);
    assert.equal(finished.exitCode, 0);
    console.log("Compact runtime smoke test passed.");
}
finally {
    await rm(runRoot, { recursive: true, force: true });
}
