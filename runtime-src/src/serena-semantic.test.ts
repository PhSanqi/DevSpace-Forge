import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SERENA_STDERR_MODE, SerenaSemanticManager, serenaChildEnvironment, serenaLanguageForPath, serenaWarmPathForWorkspace } from "./serena-semantic.js";

test("Serena stderr cannot use an unread pipe", () => {
  assert.equal(SERENA_STDERR_MODE, "inherit");
});

test("Serena finds the running Node binary even when service PATH excludes it", () => {
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = "/usr/bin:/bin";
    const env = serenaChildEnvironment("/tmp/serena-home");
    const nodeBin = path.dirname(process.execPath);
    assert.equal(env.PATH?.split(path.delimiter)[0], nodeBin);
    assert.equal(env.SERENA_HOME, "/tmp/serena-home");
    assert.equal(process.env.PATH, "/usr/bin:/bin");

    process.env.PATH = `${nodeBin}${path.delimiter}/usr/bin:/bin`;
    assert.equal(serenaChildEnvironment("/tmp/serena-home").PATH, process.env.PATH);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("Serena selects the requested file language rather than an unrelated PowerShell backend", async () => {
  assert.equal(serenaLanguageForPath("src/server.ts"), "typescript");
  assert.equal(serenaLanguageForPath("setup-linux.sh"), "bash");
  assert.equal(serenaLanguageForPath("install.ps1"), "powershell");
  assert.equal(serenaLanguageForPath("src/Program.cs"), "csharp");
  assert.equal(serenaLanguageForPath("."), undefined);
  const started: string[] = [];
  const manager = new SerenaSemanticManager({
    available: true,
    createClient: async (_root, language) => {
      started.push(language ?? "default");
      return {
        callTool: async () => ({ content: [{ type: "text", text: language ?? "default" }] }),
        close: async () => undefined,
      };
    },
  });
  try {
    assert.equal((await manager.call("/tmp/serena-multilanguage", "get_symbols_overview", {relative_path: "src/server.ts"})).result, "typescript");
    assert.equal((await manager.call("/tmp/serena-multilanguage", "get_symbols_overview", {relative_path: "setup-linux.sh"})).result, "bash");
    assert.equal((await manager.call("/tmp/serena-multilanguage", "get_symbols_overview", {relative_path: "src/other.ts"})).result, "typescript");
    assert.deepEqual(started, ["typescript", "bash"]);
  } finally {
    await manager.close();
  }
});

test("Serena warmup picks one conservative primary language from workspace markers", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "devspace-serena-warm-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(serenaWarmPathForWorkspace(root), undefined);
  writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname='example'\n");
  assert.equal(serenaWarmPathForWorkspace(root), "main.py");
  writeFileSync(path.join(root, "package.json"), "{}\n");
  assert.equal(serenaWarmPathForWorkspace(root), "src/index.ts");
});

test("missing pwsh produces a file-scoped diagnostic without starting a backend", async (t) => {
  if (process.platform === "win32" || spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0) {
    t.skip("pwsh is available on this host");
    return;
  }
  let started = false;
  const manager = new SerenaSemanticManager({
    available: true,
    createClient: async () => {
      started = true;
      throw new Error("should not start an unrelated backend");
    },
  });
  await assert.rejects(
    manager.call("/tmp/serena-multilanguage", "get_symbols_overview", { relative_path: "install.ps1" }),
    /PowerShell semantic analysis requires pwsh/,
  );
  assert.equal(started, false);
});

test("Serena semantic backends use bounded LRU reuse", async () => {
  const created: string[] = [];
  const closed: string[] = [];
  const manager = new SerenaSemanticManager({
    available: true,
    maxBackends: 2,
    createClient: async (root) => {
      created.push(root);
      return {
        callTool: async () => ({ content: [{ type: "text", text: root }] }),
        close: async () => {
          closed.push(root);
        },
      };
    },
  });

  const a = path.resolve("/tmp/devspace-serena-a");
  const b = path.resolve("/tmp/devspace-serena-b");
  const c = path.resolve("/tmp/devspace-serena-c");
  await manager.call(a, "find_symbol", {});
  await manager.call(b, "find_symbol", {});
  await manager.call(a, "find_symbol", {});
  await manager.call(c, "find_symbol", {});

  assert.deepEqual(closed, [b]);
  assert.equal(created.filter((root) => root === a).length, 1);
  assert.equal(created.filter((root) => root === b).length, 1);
  assert.equal(created.filter((root) => root === c).length, 1);

  await manager.call(b, "find_symbol", {});
  assert.equal(created.filter((root) => root === b).length, 2);
  await manager.close();
});

test("Serena semantic LRU never evicts a backend while it is busy", async () => {
  let releaseA!: () => void;
  let startedA!: () => void;
  const aStarted = new Promise<void>((resolve) => {
    startedA = resolve;
  });
  const aRelease = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const closed: string[] = [];
  const a = path.resolve("/tmp/devspace-serena-busy-a");
  const b = path.resolve("/tmp/devspace-serena-busy-b");
  const manager = new SerenaSemanticManager({
    available: true,
    maxBackends: 1,
    createClient: async (root) => ({
      callTool: async () => {
        if (root === a) {
          startedA();
          await aRelease;
        }
        return { content: [{ type: "text", text: root }] };
      },
      close: async () => {
        closed.push(root);
      },
    }),
  });

  const activeA = manager.call(a, "find_symbol", {});
  await aStarted;
  await manager.call(b, "find_symbol", {});
  assert.deepEqual(closed, [b]);
  releaseA();
  await activeA;
  assert.equal(closed.includes(a), false);
  await manager.close();
});

test("Serena warm starts and reuses a backend without a semantic tool call", async () => {
  let created = 0;
  let calls = 0;
  const root = path.resolve("/tmp/devspace-serena-warm");
  const manager = new SerenaSemanticManager({
    available: true,
    createClient: async () => {
      created += 1;
      return {
        callTool: async () => {
          calls += 1;
          return { content: [{ type: "text", text: "ready" }] };
        },
        close: async () => undefined,
      };
    },
  });

  await manager.warm(root);
  assert.equal(created, 1);
  assert.equal(calls, 0);
  const result = await manager.call(root, "find_symbol", {});
  assert.equal(result.result, "ready");
  assert.equal(created, 1);
  assert.equal(calls, 1);
  await manager.close();
});

test("Serena language warmup shares the first file backend instead of warming default", async () => {
  const created: string[] = [];
  const root = path.resolve("/tmp/devspace-serena-language-warm");
  const manager = new SerenaSemanticManager({
    available: true,
    createClient: async (_root, language) => {
      created.push(language ?? "default");
      return {
        callTool: async () => ({ content: [{ type: "text", text: language ?? "default" }] }),
        close: async () => undefined,
      };
    },
  });
  await manager.warm(root, "src/index.ts");
  assert.deepEqual(created, ["typescript"]);
  const result = await manager.call(root, "get_symbols_overview", { relative_path: "src/server.ts" });
  assert.equal(result.result, "typescript");
  assert.deepEqual(created, ["typescript"]);
  await manager.close();
});

test("Serena in-flight language warmup is reused by the first semantic call", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const created: string[] = [];
  const root = path.resolve("/tmp/devspace-serena-inflight-warm");
  const manager = new SerenaSemanticManager({
    available: true,
    createClient: async (_root, language) => {
      created.push(language ?? "default");
      await gate;
      return {
        callTool: async () => ({ content: [{ type: "text", text: language ?? "default" }] }),
        close: async () => undefined,
      };
    },
  });
  const warming = manager.warm(root, "src/index.ts");
  await new Promise((resolve) => setImmediate(resolve));
  const firstCall = manager.call(root, "get_symbols_overview", { relative_path: "src/server.ts" });
  assert.deepEqual(created, ["typescript"]);
  release();
  await warming;
  assert.equal((await firstCall).result, "typescript");
  assert.deepEqual(created, ["typescript"]);
  await manager.close();
});
