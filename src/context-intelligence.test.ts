import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { buildContextPack } from "./context-intelligence.js";
import { SerenaSemanticManager } from "./serena-semantic.js";
import { writeTestDevspaceConfig } from "./test-support/config.test.js";
import { WorkspaceRegistry } from "./workspaces.js";

test("context_pack combines lazy instructions, symbol definition, references, and a hard budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-context-pack-"));
  const agentDir = join(root, ".agent");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(root, "src", "feature"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "root rules\n");
  await writeFile(join(root, "src", "AGENTS.md"), "src rules\n");
  await writeFile(join(root, "src", "feature", "CLAUDE.md"), "feature rules\n");
  await writeFile(
    join(root, "src", "feature", "service.ts"),
    [
      "import { helper } from '../helper.js';",
      "export class Service {",
      "  run() { return helper(); }",
      "}",
      "",
    ].join("\n"),
  );

  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
    skills: { agentDir },
  }));
  const workspaces = new WorkspaceRegistry(config);
  const opened = await workspaces.openWorkspace(root);
  const calls: string[] = [];
  const semantic = new SerenaSemanticManager({
    available: true,
    createClient: async () => ({
      callTool: async ({ name }) => {
        calls.push(name);
        const text = name === "get_symbols_overview"
          ? JSON.stringify({ Class: ["Service"] })
          : name === "find_symbol"
            ? JSON.stringify([{
                name_path: "Service/run",
                relative_path: "src/feature/service.ts",
                body: "run() { return helper(); }",
              }])
            : name === "find_referencing_symbols"
              ? JSON.stringify([{
                  name_path: "ServiceTest/calls run",
                  relative_path: "test/service.test.ts",
                }])
              : "[]";
        return { content: [{ type: "text", text }] };
      },
      close: async () => undefined,
    }),
  });

  t.after(async () => {
    await semantic.close();
    await rm(root, { recursive: true, force: true });
  });

  const packed = await buildContextPack({
    workspace: opened.workspace,
    workspaces,
    semantic,
    conversationScopeId: "conversation-1",
    request: {
      path: "src/feature/service.ts",
      symbol: "Service/run",
      intent: "fix callers of run",
      maxChars: 3_000,
    },
  });

  assert.ok(packed.result.length <= 3_000);
  assert.match(packed.result, /src rules/);
  assert.match(packed.result, /feature rules/);
  assert.match(packed.result, /Service\/run/);
  assert.match(packed.result, /ServiceTest\/calls run/);
  assert.deepEqual(packed.instructionPaths, [
    "src/AGENTS.md",
    "src/feature/CLAUDE.md",
  ]);
  assert.equal(packed.semantic, true);
  assert.deepEqual(calls.slice(0, 3), [
    "get_symbols_overview",
    "find_symbol",
    "find_referencing_symbols",
  ]);

  const repeated = await buildContextPack({
    workspace: opened.workspace,
    workspaces,
    semantic,
    conversationScopeId: "conversation-1",
    request: {
      path: "src/feature/service.ts",
      symbol: "Service/run",
      depth: "focused",
    },
  });
  assert.doesNotMatch(repeated.result, /src rules/);
  assert.doesNotMatch(repeated.result, /feature rules/);
  assert.deepEqual(repeated.instructionPaths, [
    "src/AGENTS.md",
    "src/feature/CLAUDE.md",
  ]);
});

test("context_pack falls back to a bounded file header when Serena is unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-context-pack-fallback-"));
  const agentDir = join(root, ".agent");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "AGENTS.md"), "nested fallback rules\n");
  await writeFile(
    join(root, "src", "large.ts"),
    Array.from({ length: 200 }, (_, index) => `export const line${index} = ${index};`).join("\n"),
  );
  const config = loadConfig(writeTestDevspaceConfig(join(root, ".config"), {
    server: { port: 1 },
    workspaces: { allowedRoots: [root], worktreeRoot: join(root, ".worktrees") },
    skills: { agentDir },
  }));
  const workspaces = new WorkspaceRegistry(config);
  const opened = await workspaces.openWorkspace(root);
  const semantic = new SerenaSemanticManager({ available: false });

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const packed = await buildContextPack({
    workspace: opened.workspace,
    workspaces,
    semantic,
    request: { path: "src/large.ts", maxChars: 2_000 },
  });

  assert.equal(packed.semantic, false);
  assert.ok(packed.result.length <= 2_000);
  assert.match(packed.result, /nested fallback rules/);
  assert.match(packed.result, /export const line0/);
  assert.match(packed.result, /Avoid broad whole-file reads/);
});

