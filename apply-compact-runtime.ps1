param([string]$PackageRoot)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($PackageRoot)) {
    $PackageRoot = Join-Path $root 'runtime\devspace\node_modules\@waishnav\devspace'
}
$PackageRoot = [System.IO.Path]::GetFullPath($PackageRoot)
$packageJson = Join-Path $PackageRoot 'package.json'
if (-not (Test-Path -LiteralPath $packageJson)) { throw "DevSpace package not found: $PackageRoot" }
$version = (Get-Content -Raw -LiteralPath $packageJson | ConvertFrom-Json).version
if ($version -ne '1.1.0-beta.3') {
    throw "Compact runtime overlay is verified only for DevSpace 1.1.0-beta.3; found $version."
}

function Replace-Required([string]$Text, [string]$Old, [string]$New, [string]$Label) {
    $count = ([regex]::Matches($Text, [regex]::Escape($Old))).Count
    if ($count -ne 1) { throw "Patch anchor '$Label' expected once, found $count." }
    return $Text.Replace($Old, $New)
}

$sourceModules = Join-Path $root 'runtime-patches\compact-runtime'
$targetModules = Join-Path $PackageRoot 'dist\compact-runtime'
New-Item -ItemType Directory -Force -Path $targetModules | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceModules 'output-policy.js') -Destination $targetModules -Force
Copy-Item -LiteralPath (Join-Path $sourceModules 'run-store.js') -Destination $targetModules -Force
Copy-Item -LiteralPath (Join-Path $sourceModules 'process-run-store.js') -Destination $targetModules -Force
Copy-Item -LiteralPath (Join-Path $sourceModules 'retention.js') -Destination $targetModules -Force
Copy-Item -LiteralPath (Join-Path $sourceModules 'run-log-access.js') -Destination $targetModules -Force

$processPath = Join-Path $PackageRoot 'dist\process-sessions.js'
$processText = Get-Content -Raw -LiteralPath $processPath
if ($processText -notmatch 'DEVSPACE_COMPACT_RUNTIME_V1') {
    $processImport = @'
import { spawn } from "node:child_process";
import { ProcessRunLogger } from "./compact-runtime/process-run-store.js";
// DEVSPACE_COMPACT_RUNTIME_V1
'@
    $processText = Replace-Required $processText `
        'import { spawn } from "node:child_process";' `
        $processImport.TrimEnd() `
        'process import'
    $processText = Replace-Required $processText `
        "    completedSessionTtlMs;`n    nextSessionId = 1;" `
        "    completedSessionTtlMs;`n    runRoot;`n    nextSessionId = 1;" `
        'run root field'
    $processText = Replace-Required $processText `
        "        this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;`n    }" `
        "        this.completedSessionTtlMs = options.completedSessionTtlMs ?? COMPLETED_SESSION_TTL_MS;`n        this.runRoot = options.runRoot;`n    }" `
        'run root constructor'
    $processText = Replace-Required $processText `
        '        const session = this.createSession(input);' `
        '        const session = await this.createSession(input);' `
        'async session creation'
    $failedStart = @'
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.append(session, `${message}\n`);
            await session.runLogger.finish({ exitCode: 1 });
            this.sessions.delete(session.id);
            throw error;
        }
'@
    $processText = Replace-Required $processText `
        "        catch (error) {`n            this.sessions.delete(session.id);`n            throw error;`n        }" `
        $failedStart.TrimEnd() `
        'failed start logging'
    $processText = Replace-Required $processText `
        "    createSession(input) {`n        let resolveExit = () => undefined;" `
        "    async createSession(input) {`n        let resolveExit = () => undefined;" `
        'async createSession'
    $processText = Replace-Required $processText `
        "        const exitPromise = new Promise((resolve) => {`n            resolveExit = resolve;`n        });`n        return {" `
        "        const exitPromise = new Promise((resolve) => {`n            resolveExit = resolve;`n        });`n        const startedAt = Date.now();`n        const runLogger = await ProcessRunLogger.create({`n            command: input.command,`n            cwd: input.cwd,`n            workspaceRoot: input.workspaceRoot ?? input.cwd,`n            startedAtMs: startedAt,`n            root: this.runRoot,`n        });`n        return {" `
        'run logger creation'
    $processText = Replace-Required $processText `
        "            workspaceId: input.workspaceId,`n            startedAt: Date.now()," `
        "            workspaceId: input.workspaceId,`n            command: input.command,`n            startedAt,`n            lastActivityAt: startedAt,`n            runLogger," `
        'session run fields'
    $processText = Replace-Required $processText `
        "        session.resolveExit();`n        session.cleanupTimer = setTimeout(() => this.sessions.delete(session.id), this.completedSessionTtlMs);`n        session.cleanupTimer.unref();" `
        "        void session.runLogger.finish({ exitCode, signal }).finally(() => {`n            session.resolveExit();`n            session.cleanupTimer = setTimeout(() => this.sessions.delete(session.id), this.completedSessionTtlMs);`n            session.cleanupTimer.unref();`n        });" `
        'finish log before resolving'
    $processText = Replace-Required $processText `
        "    append(session, output) {`n        session.buffer.append(output);" `
        "    append(session, output) {`n        if (output)`n            session.lastActivityAt = Date.now();`n        session.runLogger.append(output);`n        session.buffer.append(output);" `
        'append full log'
    $processText = Replace-Required $processText `
        "        const buffered = session.buffer.drain(maxCharacters);`n        return {`n            sessionId: session.running ? session.id : undefined,`n            output: buffered.output," `
        "        const buffered = session.buffer.drain(maxCharacters);`n        const run = session.runLogger.snapshot();`n        return {`n            sessionId: session.running ? session.id : undefined,`n            runId: run.runId,`n            command: session.command,`n            output: buffered.output,`n            outputBytes: run.outputBytes,`n            outputLines: run.outputLines," `
        'snapshot run fields'
    $processText = Replace-Required $processText `
        "            signal: session.signal,`n            wallTimeMs:" `
        "            signal: session.signal,`n            logError: run.logError,`n            wallTimeMs:" `
        'snapshot log error'
    $statusMethod = @'
    status(workspaceId, sessionId) {
        const session = this.getOwnedSession(workspaceId, sessionId);
        const run = session.runLogger.snapshot();
        const now = Date.now();
        return {
            sessionId: session.id,
            runId: run.runId,
            command: session.command,
            outputBytes: run.outputBytes,
            outputLines: run.outputLines,
            running: session.running,
            exitCode: session.exitCode,
            signal: session.signal,
            logError: run.logError,
            wallTimeMs: now - session.startedAt,
            idleTimeMs: now - session.lastActivityAt,
        };
    }
'@
    $processText = Replace-Required $processText `
        '    terminate(workspaceId, sessionId) {' `
        ($statusMethod.TrimEnd() + "`n    terminate(workspaceId, sessionId) {") `
        'nonblocking process status'
    [System.IO.File]::WriteAllText($processPath, $processText, [System.Text.UTF8Encoding]::new($false))
}

$codexPath = Join-Path $PackageRoot 'dist\tool-surfaces\codex.js'
$codexText = Get-Content -Raw -LiteralPath $codexPath
if ($codexText -notmatch 'DEVSPACE_COMPACT_RUNTIME_V1') {
    $codexImports = @'
import { applyPatch } from "../apply-patch.js";
import { handleRunLogCommand } from "../compact-runtime/run-log-access.js";
import { compactPreview } from "../compact-runtime/output-policy.js";
// DEVSPACE_COMPACT_RUNTIME_V1
'@
    $codexText = Replace-Required $codexText `
        'import { applyPatch } from "../apply-patch.js";' `
        $codexImports.TrimEnd() `
        'codex imports'
    $oldResult = @'
function processResult(snapshot) {
    const status = snapshot.running
        ? `Process running with session ID ${snapshot.sessionId}.`
        : snapshot.signal
            ? `Process exited after signal ${snapshot.signal}.`
            : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
    return snapshot.output
        ? `${snapshot.output.replace(/\n$/, "")}\n${status}`
        : status;
}
'@
    $newResult = @'
function processResult(snapshot) {
    const isError = processIsError(snapshot);
    const status = snapshot.running ? `running session=${snapshot.sessionId}` : snapshot.signal ? `signal=${snapshot.signal}` : `exit=${snapshot.exitCode ?? "unknown"}`;
    const lines = [`run=${snapshot.runId} status=${status} duration=${snapshot.wallTimeMs}ms output=${snapshot.outputLines}L/${snapshot.outputBytes}B`];
    const preview = compactPreview(snapshot.output, isError, snapshot.command);
    if (preview) lines.push(preview);
    if (snapshot.logError) lines.push(`log=unavailable; warning=full local log persistence failed: ${snapshot.logError}`);
    else lines.push(`log=${snapshot.runId}; more=devspace-log read ${snapshot.runId} 1 80; search=devspace-log grep ${snapshot.runId} <pattern>`);
    return lines.join("\n");
}
function processIsError(snapshot) {
    return Boolean(snapshot.signal) || (!snapshot.running && (snapshot.exitCode ?? 0) !== 0);
}
'@
    $codexText = Replace-Required $codexText $oldResult $newResult 'compact process result'
    $codexText = Replace-Required $codexText `
        "        session_id: z.number().optional(),`n        running: z.boolean()," `
        "        session_id: z.number().optional(),`n        run_id: z.string(),`n        running: z.boolean()," `
        'schema run id'
    $codexText = Replace-Required $codexText `
        "        wall_time_ms: z.number().nonnegative(),`n        output_truncated: z.boolean()," `
        "        wall_time_ms: z.number().nonnegative(),`n        idle_time_ms: z.number().nonnegative().optional(),`n        output_bytes: z.number().nonnegative(),`n        output_lines: z.number().nonnegative(),`n        output_truncated: z.boolean(),`n        log_error: z.string().optional()," `
        'schema metrics'
    $codexText = Replace-Required $codexText `
        "            session_id: snapshot.sessionId,`n            running: snapshot.running," `
        "            session_id: snapshot.sessionId,`n            run_id: snapshot.runId,`n            running: snapshot.running," `
        'response run id'
    $codexText = Replace-Required $codexText `
        "        content,`n        structuredContent: {" `
        "        content,`n        isError: processIsError(snapshot),`n        structuredContent: {" `
        'response error semantic'
    $codexText = Replace-Required $codexText `
        "            wall_time_ms: snapshot.wallTimeMs,`n            output_truncated: snapshot.outputTruncated," `
        "            wall_time_ms: snapshot.wallTimeMs,`n            ...(snapshot.running ? { idle_time_ms: snapshot.idleTimeMs } : {}),`n            output_bytes: snapshot.outputBytes,`n            output_lines: snapshot.outputLines,`n            output_truncated: snapshot.outputTruncated,`n            ...(snapshot.logError ? { log_error: snapshot.logError } : {})," `
        'response metrics'
    $runLogResponse = @'
function runLogToolResponse(command, result) {
    const runId = command.trim().split(/\s+/)[2] ?? "run_unknown";
    return {
        content: [textBlock(result)],
        structuredContent: {
            result, run_id: runId, running: false, wall_time_ms: 0,
            output_bytes: Buffer.byteLength(result, "utf8"),
            output_lines: result === "" ? 0 : result.split(/\r?\n/).length,
            output_truncated: false,
        },
    };
}
'@
    $codexText = Replace-Required $codexText `
        "}`nfunction registerApplyPatchTool" `
        "}`n$runLogResponse`nfunction registerApplyPatchTool" `
        'run log response helper'
    $codexText = Replace-Required $codexText `
        'description: "Run a shell command in a workspace with the user''s local permissions. Returns the result when it exits during the yield window, otherwise returns a session_id for write_stdin.",' `
        'description: "Run a shell command in a workspace with the user''s local permissions. Full output is persisted locally while the MCP result stays compact and includes a run_id. Returns a session_id when still running. devspace-log commands retrieve bounded portions of stored output.",' `
        'exec description'
    $handlerAnchor = @'
    }, async ({ workspace_id, cmd, tty, columns, rows, working_directory, yield_time_ms, max_output_tokens, }) => {
        const startedAt = performance.now();
        const workspaceId = workspace_id;
'@
    $handlerReplacement = @'
    }, async ({ workspace_id, cmd, tty, columns, rows, working_directory, yield_time_ms, max_output_tokens, }) => {
        const startedAt = performance.now();
        const workspaceId = workspace_id;
        await workspaces.getWorkspace(workspaceId);
        const runLogResult = await handleRunLogCommand(cmd);
        if (runLogResult !== null)
            return runLogToolResponse(cmd, runLogResult);
'@
    $codexText = Replace-Required $codexText $handlerAnchor $handlerReplacement 'devspace-log handler'
    $statusTool = @'
    server.registerTool("process_status", {
        title: "Check process status",
        description: "Check a process session without waiting or consuming buffered output. Use write_stdin only when output or interaction is needed.",
        inputSchema: {
            workspace_id: z.string().describe("Workspace identifier used to start the process."),
            session_id: z.number().describe("Process session identifier returned by exec_command."),
        },
        outputSchema: processOutputSchema(),
        annotations: SHELL_TOOL_ANNOTATIONS,
    }, async ({ workspace_id, session_id }) => {
        const startedAt = performance.now();
        const workspaceId = workspace_id;
        const status = await runLoggedToolOperation(config, { tool: "process_status", workspaceId }, startedAt, async () => {
            await workspaces.getWorkspace(workspaceId);
            return processSessions.status(workspaceId, session_id);
        });
        const state = status.running ? "running" : status.signal ? `signal=${status.signal}` : `exit=${status.exitCode ?? "unknown"}`;
        const result = `run=${status.runId} status=${state} session=${status.sessionId} duration=${status.wallTimeMs}ms idle=${status.idleTimeMs}ms output=${status.outputLines}L/${status.outputBytes}B`;
        return {
            content: [textBlock(result)],
            structuredContent: {
                result,
                session_id: status.sessionId,
                run_id: status.runId,
                running: status.running,
                exit_code: status.exitCode,
                signal: status.signal,
                wall_time_ms: status.wallTimeMs,
                idle_time_ms: status.idleTimeMs,
                output_bytes: status.outputBytes,
                output_lines: status.outputLines,
                output_truncated: false,
                ...(status.logError ? { log_error: status.logError } : {}),
            },
        };
    });
'@
    $codexText = Replace-Required $codexText `
        '    server.registerTool("write_stdin", {' `
        ($statusTool.TrimEnd() + "`n    server.registerTool(`"write_stdin`", {") `
        'process status tool'
    $codexText = Replace-Required $codexText `
        'description: "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",' `
        'description: "Poll or write characters to a process returned by exec_command. Full output remains in the same local run log. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",' `
        'write description'
    [System.IO.File]::WriteAllText($codexPath, $codexText, [System.Text.UTF8Encoding]::new($false))
}

Write-Host "Compact runtime overlay ready for DevSpace $version at $PackageRoot"
