import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compactPreview } from "./output-policy.js";
import { ProcessRunLogger } from "./process-run-store.js";
import { handleRunLogCommand } from "./run-log-access.js";

test("compact process logs keep full output while model preview stays bounded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "devspace-compact-test-"));
  try {
    const logger = await ProcessRunLogger.create({
      command: "npm test",
      cwd: root,
      workspaceRoot: root,
      root,
    });
    for (let index = 1; index <= 120; index += 1) {
      logger.append(`line ${index} payload payload payload\n`);
    }
    const meta = await logger.finish({ exitCode: 0 });
    assert.equal(meta.outputLines, 120);
    assert.ok(meta.outputBytes > 2_000);

    const tail = await handleRunLogCommand(
      `devspace-log tail ${logger.runId} 3`,
      root,
    );
    assert.match(tail ?? "", /line 118/);
    assert.match(tail ?? "", /line 120/);

    const grep = await handleRunLogCommand(
      `devspace-log grep ${logger.runId} line 42`,
      root,
    );
    assert.match(grep ?? "", /line 42/);

    const preview = compactPreview(
      Array.from({ length: 80 }, (_, index) => `test output ${index}`).join("\n"),
      false,
      "npm test",
    );
    assert.ok(preview.length <= 701);
    assert.match(preview, /test output 79/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
