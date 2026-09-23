import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface SerenaClientLike {
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface SerenaSemanticManagerOptions {
  available?: boolean;
  createClient?: (root: string, language?: string) => Promise<SerenaClientLike>;
  timeoutMs?: number;
  maxBackends?: number;
}

// Keep Serena stderr attached to the DevSpace service rather than an unread pipe.
// An unread child-process pipe can fill and deadlock the semantic backend.
export const SERENA_STDERR_MODE = "inherit" as const;

function serenaCommand(): string {
  const configured = process.env.DEVSPACE_SERENA_BIN?.trim();
  if (configured) return configured;
  const userLocal = path.join(
    homedir(),
    ".local",
    "bin",
    process.platform === "win32" ? "serena.exe" : "serena",
  );
  return existsSync(userLocal) ? userLocal : "serena";
}

function installed(): boolean {
  const result = spawnSync(serenaCommand(), ["--version"], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 2_000,
  });
  return !result.error && result.status === 0;
}

function textFromResult(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const value = result as {
    structuredContent?: { result?: unknown };
    content?: Array<{ type?: string; text?: string }>;
  };
  if (typeof value.structuredContent?.result === "string") {
    return value.structuredContent.result;
  }
  return (value.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

// Isolate explicit file-language backends from Serena's default project auto-
// detection. A PowerShell-heavy checkout must not require pwsh to inspect a
// TypeScript or Bash file.
export function serenaLanguageForPath(relativePath: unknown): string | undefined {
  if (typeof relativePath !== "string") return undefined;
  const extension = path.extname(relativePath).toLowerCase();
  if ([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(extension)) return "typescript";
  if ([".sh", ".bash"].includes(extension)) return "bash";
  if ([".ps1", ".psm1", ".psd1"].includes(extension)) return "powershell";
  if (extension === ".py") return "python";
  if (extension === ".cs") return "csharp";
  if (extension === ".go") return "go";
  if (extension === ".rs") return "rust";
  if (extension === ".java") return "java";
  if ([".c", ".cc", ".cpp", ".h", ".hpp"].includes(extension)) return "cpp";
  return undefined;
}

export function serenaWarmPathForWorkspace(root: string): string | undefined {
  const marker = (name: string) => existsSync(path.join(root, name));
  if (marker("tsconfig.json") || marker("package.json")) return "src/index.ts";
  if (marker("pyproject.toml") || marker("requirements.txt") || marker("setup.py")) return "main.py";
  if (marker("go.mod")) return "main.go";
  if (marker("Cargo.toml")) return "src/main.rs";
  if (marker("pom.xml") || marker("build.gradle") || marker("build.gradle.kts")) return "src/Main.java";
  if (marker("CMakeLists.txt")) return "src/main.cpp";
  if (marker("setup-linux.sh") || marker("install.sh") || marker("setup.sh")) return "setup-linux.sh";
  try {
    const names = readdirSync(root);
    if (names.some((name) => /\.(?:sln|csproj)$/i.test(name))) return "Program.cs";
    if (process.platform === "win32" && names.some((name) => /\.(?:ps1|psm1|psd1)$/i.test(name))) return "setup.ps1";
  } catch {
    return undefined;
  }
  return undefined;
}

async function managedSerenaHome(root: string, language?: string): Promise<string> {
  const digest = createHash("sha256")
    .update(path.resolve(root) + (language ? `\0${language}` : ""))
    .digest("hex")
    .slice(0, 20);
  const baseRoot = process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, "devspace", "serena")
    : path.join(homedir(), ".local", "share", "devspace", "serena");
  const base = path.join(baseRoot, digest);
  const projectData = path.join(base, "project-data");
  await mkdir(projectData, { recursive: true, mode: 0o700 });
  if (language) {
    const projectConfig = path.join(projectData, "project.yml");
    try {
      await access(projectConfig);
    } catch {
      await writeFile(projectConfig,
        `project_name: ${JSON.stringify(path.basename(root))}\nlanguage_servers:\n- ${language}\n`,
        { flag: "wx", mode: 0o600 },
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
  }
  const configPath = path.join(base, "serena_config.yml");
  try {
    await access(configPath);
  } catch {
    await writeFile(
      configPath,
      `projects: []\nproject_serena_folder_location: ${JSON.stringify(projectData)}\n`,
      { mode: 0o600 },
    );
  }
  return base;
}

// A packaged service may launch Node by absolute path without adding its bin
// directory to PATH. Serena's language servers still need to resolve `node`.
export function serenaChildEnvironment(serenaHome: string): Record<string, string> {
  const nodeBin = path.dirname(process.execPath);
  const parentPath = process.env.PATH ?? "";
  const childPath = parentPath.split(path.delimiter).includes(nodeBin)
    ? parentPath
    : [nodeBin, parentPath].filter(Boolean).join(path.delimiter);
  return Object.fromEntries(
    Object.entries({ ...process.env, PATH: childPath, SERENA_HOME: serenaHome })
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function createClient(root: string, language?: string): Promise<SerenaClientLike> {
  const serenaHome = await managedSerenaHome(root, language);
  const transport = new StdioClientTransport({
    command: serenaCommand(),
    args: [
      "start-mcp-server",
      "--project",
      root,
      "--context",
      "codex",
      "--transport",
      "stdio",
      "--enable-web-dashboard",
      "false",
      "--open-web-dashboard",
      "false",
      "--enable-gui-log-window",
      "false",
      "--log-level",
      "ERROR",
    ],
    cwd: root,
    env: serenaChildEnvironment(serenaHome),
    stderr: SERENA_STDERR_MODE,
  });
  const client = new Client({ name: "devspace-serena-backend", version: "1" });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Serena MCP connect timeout")),
          15_000,
        );
        timer.unref();
      }),
    ]);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return client;
}

export class SerenaSemanticManager {
  readonly available: boolean;
  private readonly clients = new Map<
    string,
    Promise<{ client: SerenaClientLike; startedAt: number }>
  >();
  private readonly busy = new Map<string, number>();
  private readonly factory: (root: string, language?: string) => Promise<SerenaClientLike>;
  private readonly timeoutMs: number;
  private readonly maxBackends: number;

  constructor(options: SerenaSemanticManagerOptions = {}) {
    this.available = options.available ?? installed();
    this.factory = options.createClient ?? createClient;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBackends = Math.max(1, options.maxBackends ?? 4);
  }

  async warm(root: string, relativePath?: string): Promise<void> {
    if (!this.available) return;
    const language = serenaLanguageForPath(relativePath);
    if (language === "powershell" && process.platform !== "win32") return;
    await this.backend(path.resolve(root), language);
  }

  async call(
    root: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ result: string; truncated: boolean; backendAgeMs: number }> {
    if (!this.available) {
      throw new Error("Serena semantic backend is not installed.");
    }
    const language = serenaLanguageForPath(args.relative_path);
    if (language === "powershell" && process.platform !== "win32") {
      const check = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore", timeout: 2_000 });
      if (check.error || check.status !== 0) {
        throw new Error("PowerShell semantic analysis requires pwsh; other file languages remain available.");
      }
    }
    const key = `${path.resolve(root)}\0${language ?? "default"}`;
    this.busy.set(key, (this.busy.get(key) ?? 0) + 1);
    let backend: { client: SerenaClientLike; startedAt: number } | undefined;
    try {
      backend = await this.backend(path.resolve(root), language);
      const response = await backend.client.callTool(
        { name: tool, arguments: args },
        undefined,
        { timeout: this.timeoutMs },
      );
      const raw = textFromResult(response);
      const truncated = raw.length > 8_000;
      const result = truncated
        ? `${raw.slice(0, 3_950)}\n... semantic result truncated; refine the query ...\n${raw.slice(-3_950)}`
        : raw;
      return {
        result,
        truncated,
        backendAgeMs: Math.max(0, Date.now() - backend.startedAt),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timeout/i.test(message)) {
        throw new Error(
          `Serena semantic backend timed out after ${this.timeoutMs}ms; it may still be warming or indexing. Retry later or use DevSpace text tools meanwhile.`,
        );
      }
      if (/(connection|transport|channel|stream).*(closed|ended|reset)|\bEOF\b|ECONNRESET|EPIPE|not connected/i.test(message)) {
        this.clients.delete(key);
        await backend?.client.close().catch(() => undefined);
        throw new Error(
          "Serena semantic backend disconnected; the next semantic call will start a fresh backend.",
        );
      }
      throw error;
    } finally {
      const remaining = (this.busy.get(key) ?? 1) - 1;
      if (remaining > 0) this.busy.set(key, remaining);
      else this.busy.delete(key);
      await this.trimBackends();
    }
  }

  async close(): Promise<void> {
    const clients = await Promise.allSettled(this.clients.values());
    this.clients.clear();
    this.busy.clear();
    await Promise.allSettled(
      clients
        .filter(
          (
            item,
          ): item is PromiseFulfilledResult<{
            client: SerenaClientLike;
            startedAt: number;
          }> => item.status === "fulfilled",
        )
        .map((item) => item.value.client.close()),
    );
  }

  private async backend(
    root: string,
    language?: string,
  ): Promise<{ client: SerenaClientLike; startedAt: number }> {
    const key = `${path.resolve(root)}\0${language ?? "default"}`;
    const existing = this.clients.get(key);
    if (existing) {
      this.clients.delete(key);
      this.clients.set(key, existing);
      return existing;
    }
    const created = this.factory(path.resolve(root), language)
      .then((client) => ({ client, startedAt: Date.now() }))
      .catch((error) => {
        this.clients.delete(key);
        throw error;
      });
    this.clients.set(key, created);
    await this.trimBackends();
    return created;
  }

  private async trimBackends(): Promise<void> {
    while (this.clients.size > this.maxBackends) {
      let candidate: string | undefined;
      for (const key of this.clients.keys()) {
        if ((this.busy.get(key) ?? 0) === 0) {
          candidate = key;
          break;
        }
      }
      if (!candidate) return;
      const backend = this.clients.get(candidate);
      this.clients.delete(candidate);
      if (!backend) continue;
      const settled = await backend
        .then((value) => value)
        .catch(() => undefined);
      await settled?.client.close().catch(() => undefined);
    }
  }
}
