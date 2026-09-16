import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { SerenaSemanticManager } from "./serena-semantic.js";
import {
  formatAgentsPath,
  type LoadedAgentsFile,
  type Workspace,
  type WorkspaceRegistry,
} from "./workspaces.js";

export type ContextPackDepth = "focused" | "standard" | "deep";

export interface ContextPackInput {
  path: string;
  symbol?: string;
  intent?: string;
  depth?: ContextPackDepth;
  maxChars?: number;
}

export interface ContextPackResult {
  result: string;
  truncated: boolean;
  semantic: boolean;
  backendAgeMs?: number;
  instructionPaths: string[];
  sections: string[];
  resolvedPath: string;
  resolvedSymbolPath?: string;
}

interface SemanticResult {
  result: string;
  truncated: boolean;
  backendAgeMs: number;
}

const DEFAULT_MAX_CHARS = 9_000;
const MIN_MAX_CHARS = 2_000;
const HARD_MAX_CHARS = 20_000;

function boundedMaxChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CHARS;
  if (!Number.isFinite(value)) return DEFAULT_MAX_CHARS;
  return Math.min(HARD_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.floor(value)));
}

function clipText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  if (maxChars < 160) {
    return { text: text.slice(0, maxChars), truncated: true };
  }
  const marker = "\n… [section clipped; refine the context request] …\n";
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available * 0.7);
  const tail = available - head;
  return {
    text: `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`,
    truncated: true,
  };
}

class ContextPackWriter {
  private readonly chunks: string[] = [];
  private used = 0;
  private clipped = false;
  readonly sections: string[] = [];

  constructor(private readonly maxChars: number) {}

  add(label: string, value: string | undefined, sectionCap: number): void {
    const text = value?.trim();
    if (!text) return;
    const prefix = `${this.chunks.length === 0 ? "" : "\n\n"}## ${label}\n`;
    const remaining = this.maxChars - this.used - prefix.length;
    if (remaining <= 80) {
      this.clipped = true;
      return;
    }
    const capped = Math.min(sectionCap, remaining);
    const clipped = clipText(text, capped);
    this.chunks.push(`${prefix}${clipped.text}`);
    this.used += prefix.length + clipped.text.length;
    this.sections.push(label);
    this.clipped ||= clipped.truncated;
  }

  finish(footer?: string): { result: string; truncated: boolean } {
    if (footer) {
      const prefix = `${this.chunks.length === 0 ? "" : "\n\n"}${footer}`;
      const remaining = this.maxChars - this.used;
      if (remaining > 80) {
        const clipped = clipText(prefix, remaining);
        this.chunks.push(clipped.text);
        this.clipped ||= clipped.truncated;
      } else {
        this.clipped = true;
      }
    }
    return { result: this.chunks.join(""), truncated: this.clipped };
  }
}

async function readHead(
  filePath: string,
  maxLines: number,
  maxChars: number,
): Promise<string> {
  const lines: string[] = [];
  let chars = 0;
  const input = createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (lines.length >= maxLines || chars >= maxChars) break;
      const remaining = maxChars - chars;
      lines.push(line.length > remaining ? `${line.slice(0, Math.max(0, remaining - 1))}…` : line);
      chars += Math.min(line.length, remaining) + 1;
    }
  } finally {
    reader.close();
    input.destroy();
  }
  return lines.join("\n");
}

function formatInstructions(files: LoadedAgentsFile[], workspaceRoot: string): string {
  return files
    .map((file) => {
      const display = formatAgentsPath(file.path, workspaceRoot);
      return `### ${display}\n${file.content.trim()}`;
    })
    .join("\n\n");
}

function semanticRecords(result: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(result) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (value): value is Record<string, unknown> => Boolean(value) && typeof value === "object",
      );
    }
    if (parsed && typeof parsed === "object") return [parsed as Record<string, unknown>];
  } catch {
    // Some Serena backends return human-readable text instead of JSON.
  }
  return [];
}

function firstSemanticLocation(
  result: string,
  fallbackPath: string,
  fallbackSymbol: string,
): {
  relativePath: string;
  namePath: string;
  bodyStartLine?: number;
  bodyEndLine?: number;
} {
  const first = semanticRecords(result)[0];
  const bodyLocation = first?.body_location;
  const body = bodyLocation && typeof bodyLocation === "object"
    ? bodyLocation as Record<string, unknown>
    : undefined;
  return {
    relativePath:
      typeof first?.relative_path === "string" ? first.relative_path : fallbackPath,
    namePath:
      typeof first?.name_path === "string" ? first.name_path : fallbackSymbol,
    bodyStartLine:
      typeof body?.start_line === "number" ? body.start_line : undefined,
    bodyEndLine:
      typeof body?.end_line === "number" ? body.end_line : undefined,
  };
}

async function readRange(
  filePath: string,
  startLine: number,
  endLine: number,
  maxLines: number,
  maxChars: number,
): Promise<string> {
  const lines: string[] = [];
  let chars = 0;
  let lineNumber = 0;
  const input = createReadStream(filePath, { encoding: "utf8" });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (lineNumber < startLine) continue;
      if (lineNumber > endLine || lines.length >= maxLines || chars >= maxChars) break;
      const remaining = maxChars - chars;
      lines.push(line.length > remaining ? `${line.slice(0, Math.max(0, remaining - 1))}…` : line);
      chars += Math.min(line.length, remaining) + 1;
    }
  } finally {
    reader.close();
    input.destroy();
  }
  return lines.join("\n");
}

function wantsDiagnostics(intent: string | undefined, depth: ContextPackDepth): boolean {
  if (depth === "deep") return true;
  return /\b(error|errors|diagnostic|diagnostics|typecheck|type error|compile|lint|bug|fix)\b/i
    .test(intent ?? "");
}

function wantsImplementations(intent: string | undefined, depth: ContextPackDepth): boolean {
  if (depth === "deep") return true;
  return /\b(implementation|implementations|override|interface|abstract|subclass|concrete)\b/i
    .test(intent ?? "");
}

async function semanticCall(
  semantic: SerenaSemanticManager | undefined,
  root: string,
  tool: string,
  args: Record<string, unknown>,
  warnings: string[],
): Promise<SemanticResult | undefined> {
  if (!semantic?.available) return undefined;
  try {
    return await semantic.call(root, tool, args);
  } catch (error) {
    warnings.push(
      `${tool}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

export async function buildContextPack(input: {
  workspace: Workspace;
  workspaces: WorkspaceRegistry;
  semantic?: SerenaSemanticManager;
  request: ContextPackInput;
  conversationScopeId?: string;
}): Promise<ContextPackResult> {
  const { workspace, workspaces, semantic, request, conversationScopeId } = input;
  const maxChars = boundedMaxChars(request.maxChars);
  const depth = request.depth ?? "standard";
  const resolved = await workspaces.resolvePath(workspace, request.path);
  const relativePath = path
    .relative(workspace.canonicalRoot, resolved)
    .split(path.sep)
    .join("/");
  const pathForSemantic = relativePath === "" ? "." : relativePath;

  const applicable = await workspaces.loadApplicableAgentsFiles(workspace, request.path);
  const deduped = workspaces.dedupeConversationAgentsFiles(
    conversationScopeId,
    workspace.root,
    applicable,
  );
  const instructionPaths = applicable.map((file) => formatAgentsPath(file.path, workspace.root));
  const warnings: string[] = [];
  const semanticResults: SemanticResult[] = [];

  let isFile = false;
  try {
    isFile = (await stat(resolved)).isFile();
  } catch {
    // A missing target is still useful for instruction discovery and semantic
    // search rooted at an existing parent directory.
  }

  const overviewPromise = semanticCall(
    semantic,
    workspace.root,
    "get_symbols_overview",
    {
      relative_path: pathForSemantic,
      max_answer_chars: depth === "focused" ? 2_000 : 3_500,
    },
    warnings,
  );
  const definitionPromise = request.symbol
    ? semanticCall(
        semantic,
        workspace.root,
        "find_symbol",
        {
          name_path_pattern: request.symbol,
          relative_path: pathForSemantic === "." ? "" : pathForSemantic,
          include_body: false,
          include_info: true,
          max_answer_chars: depth === "focused" ? 2_000 : 3_000,
        },
        warnings,
      )
    : Promise.resolve(undefined);
  const diagnosticsPromise = isFile && wantsDiagnostics(request.intent, depth)
    ? semanticCall(
        semantic,
        workspace.root,
        "get_diagnostics_for_file",
        { relative_path: pathForSemantic, max_answer_chars: 2_500 },
        warnings,
      )
    : Promise.resolve(undefined);

  const [overview, definition, diagnostics] = await Promise.all([
    overviewPromise,
    definitionPromise,
    diagnosticsPromise,
  ]);
  for (const result of [overview, definition, diagnostics]) {
    if (result) semanticResults.push(result);
  }

  let references: SemanticResult | undefined;
  let implementations: SemanticResult | undefined;
  let symbolSource: string | undefined;
  let resolvedSymbolPath: string | undefined;

  if (request.symbol && definition) {
      const location = firstSemanticLocation(
        definition.result,
        pathForSemantic === "." ? "" : pathForSemantic,
        request.symbol,
      );
      resolvedSymbolPath = location.relativePath || undefined;
      if (
        location.relativePath
        && location.bodyStartLine !== undefined
        && location.bodyEndLine !== undefined
      ) {
        try {
          const sourcePath = await workspaces.resolvePath(
            workspace,
            location.relativePath,
          );
          const startLine = location.bodyStartLine + 1;
          const endLine = location.bodyEndLine + 1;
          const source = await readRange(
            sourcePath,
            startLine,
            endLine,
            depth === "deep" ? 140 : depth === "focused" ? 45 : 80,
            depth === "deep" ? 6_000 : depth === "focused" ? 2_200 : 3_600,
          );
          if (source) {
            symbolSource = `${location.relativePath}:${startLine}-${endLine}\n${source}`;
          }
        } catch (error) {
          warnings.push(
            `symbol source: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const referencesPromise = depth !== "focused" && location.relativePath
        ? semanticCall(
            semantic,
            workspace.root,
            "find_referencing_symbols",
            {
              name_path: location.namePath,
              relative_path: location.relativePath,
              max_answer_chars: depth === "deep" ? 4_000 : 2_800,
            },
            warnings,
          )
        : Promise.resolve(undefined);
      const implementationsPromise =
        wantsImplementations(request.intent, depth) && location.relativePath
          ? semanticCall(
              semantic,
              workspace.root,
              "find_implementations",
              {
                name_path: location.namePath,
                relative_path: location.relativePath,
                include_info: true,
                max_answer_chars: 2_500,
              },
              warnings,
            )
          : Promise.resolve(undefined);
      [references, implementations] = await Promise.all([
        referencesPromise,
        implementationsPromise,
      ]);
      for (const result of [references, implementations]) {
        if (result) semanticResults.push(result);
      }
  }

  let header: string | undefined;
  if (isFile && (!request.symbol || depth === "deep")) {
    try {
      header = await readHead(
        resolved,
        depth === "deep" ? 100 : 60,
        depth === "deep" ? 4_000 : 2_500,
      );
    } catch (error) {
      warnings.push(`header: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const writer = new ContextPackWriter(maxChars);
  writer.add(
    "Target",
    [
      `path: ${request.path}`,
      request.symbol ? `symbol: ${request.symbol}` : undefined,
      request.intent ? `intent: ${request.intent}` : undefined,
      `depth: ${depth}`,
    ].filter(Boolean).join("\n"),
    900,
  );
  writer.add(
    "Applicable nested instructions",
    formatInstructions(deduped.files, workspace.root),
    Math.min(3_000, Math.floor(maxChars * 0.3)),
  );
  if (request.symbol) {
    writer.add(
      "Symbol definition",
      definition?.result,
      Math.min(2_000, Math.floor(maxChars * 0.22)),
    );
    writer.add(
      "Symbol source",
      symbolSource,
      Math.min(4_000, Math.floor(maxChars * 0.42)),
    );
    writer.add(
      "References",
      references?.result,
      Math.min(3_200, Math.floor(maxChars * 0.3)),
    );
    writer.add("Implementations", implementations?.result, 2_500);
  }
  writer.add(
    "Symbol outline",
    overview?.result,
    Math.min(3_000, Math.floor(maxChars * 0.3)),
  );
  writer.add("Diagnostics", diagnostics?.result, 2_500);
  writer.add("File header", header, 2_500);
  writer.add("Backend warnings", warnings.join("\n"), 1_800);

  const next = request.symbol
    ? `Next: refine with semantic_code on ${resolvedSymbolPath ?? pathForSemantic} if a specific caller, implementation, or diagnostic needs deeper inspection. Avoid reading the entire file unless the requested range is genuinely required.`
    : `Next: choose a symbol from the outline and request context_pack with symbol=<name>, or use semantic_code for a targeted relation. Avoid broad whole-file reads.`;
  const packed = writer.finish(next);

  return {
    result: packed.result,
    truncated:
      packed.truncated
      || semanticResults.some((result) => result.truncated),
    semantic: semanticResults.length > 0,
    backendAgeMs:
      semanticResults.length > 0
        ? Math.max(...semanticResults.map((result) => result.backendAgeMs))
        : undefined,
    instructionPaths,
    sections: writer.sections,
    resolvedPath: relativePath || ".",
    resolvedSymbolPath,
  };
}

