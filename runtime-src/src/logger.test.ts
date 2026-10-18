import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { requestIp, type TrustProxyMode } from "./logger.js";

async function observedIps(trustProxy: TrustProxyMode): Promise<{ reqIp: string; logged: string }> {
  const app = express();
  if (trustProxy) app.set("trust proxy", trustProxy);
  app.get("/", (req, res) => {
    res.json({ reqIp: req.ip, logged: requestIp(req, trustProxy) });
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: {
        "cf-connecting-ip": "192.0.2.99",
        "x-forwarded-for": "198.51.100.66, 203.0.113.7",
      },
    });
    return await response.json() as { reqIp: string; logged: string };
  } finally {
    server.close();
  }
}

test("disabled trust proxy ignores forwarding headers", async () => {
  assert.deepEqual(await observedIps(false), { reqIp: "127.0.0.1", logged: "127.0.0.1" });
});

test("loopback trust proxy uses the hop appended by the local proxy", async () => {
  assert.deepEqual(await observedIps("loopback"), { reqIp: "203.0.113.7", logged: "203.0.113.7" });
});

test("full trust proxy accepts client-supplied forwarding headers", async () => {
  assert.deepEqual(await observedIps(true), { reqIp: "198.51.100.66", logged: "192.0.2.99" });
});

test("failing command output stays in the tool response and never enters diagnostics", async (t) => {
  const { runShellTool } = await import("./pi-tools.js");
  const { logFailedToolResponse } = await import("./tool-surfaces/shared.js");
  const { logEvent, diagnosticFailure } = await import("./logger.js");
  const secret = "ghp_" + "syntheticFixture".repeat(3);
  const bearer = "Bearer " + "syntheticBearer".repeat(3);
  const output = `private-output ${secret} ${bearer}`;
  const node = process.platform === "win32" ? `"${process.execPath}"` : JSON.stringify(process.execPath);
  const response = await runShellTool({ command: `${node} -e "console.log('${output}');process.exit(7)"` }, { cwd: process.cwd() });
  assert.equal(response.isError, true);
  assert.ok(JSON.stringify(response.content).includes(secret), "the caller retains its explicit output channel");
  assert.equal(response.failure?.exitCode, 7);
  const logs: string[] = [];
  t.mock.method(console, "warn", (line: string) => logs.push(line));
  t.mock.method(console, "error", (line: string) => logs.push(line));
  for (const format of ["json", "pretty"] as const) {
    const logging = { level: "debug", format, toolCalls: true, shellCommands: false } as const;
    logFailedToolResponse({ logging } as import("./config.js").ServerConfig,
      { tool: "bash", command: "synthetic command" }, performance.now(), response.failure);
    logEvent(logging as import("./logger.js").LoggingConfig, "error", "failure", { error: `${secret} ${bearer}` });
  }
  const text = logs.join("\n");
  assert.doesNotMatch(text, /private-output/);
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes(bearer));
  assert.match(text, /ToolExecutionError/);
  assert.match(text, /exitCode/);
  assert.equal(diagnosticFailure(new Error(output), true), "Error");
});

test("diagnostic error sanitization covers common secret shapes before truncation", async () => {
  const { sanitizeDiagnosticError, diagnosticFailure } = await import("./logger.js");
  const samples = ["Bearer " + "fixture-value", "sk-" + "fixture".repeat(5),
    "ghp_" + "fixture".repeat(4), "github_pat_" + "fixture".repeat(4),
    "xoxb-" + "fixture-value", "AKIA" + "A".repeat(16), "ASIA" + "B".repeat(16),
    "password=fixture-value", "token='fixture value'", "passwd=fixture-value",
    "secret=fixture-value", "api_key=fixture-value", "https://user:fixture-secret@example.com"];
  for (const sample of samples) {
    assert.ok(!sanitizeDiagnosticError(sample).includes("fixture"));
    assert.match(sanitizeDiagnosticError(sample), /REDACTED/);
  }
  assert.equal(sanitizeDiagnosticError("x".repeat(1000)).length, 240);
  assert.equal(diagnosticFailure(new TypeError("first line\nsecond line")), "TypeError: first line");
});
