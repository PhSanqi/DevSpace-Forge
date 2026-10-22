import type { Request } from "express";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type LogFormat = "json" | "pretty";
export type TrustProxyMode = boolean | "loopback";

export interface LoggingConfig {
  level: LogLevel;
  format: LogFormat;
  requests: boolean;
  assets: boolean;
  toolCalls: boolean;
  shellCommands: boolean;
  trustProxy: TrustProxyMode;
}

type LogFields = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export function shouldLog(config: LoggingConfig, level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_WEIGHT[config.level] >= LEVEL_WEIGHT[level];
}

export function logEvent(
  config: LoggingConfig,
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: LogFields = {},
): void {
  if (!shouldLog(config, level)) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
    ...(typeof fields.error === "string" ? { error: sanitizeDiagnosticError(fields.error) } : {}),
  };

  const line = config.format === "pretty" ? formatPretty(entry) : JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function requestIp(req: Request, trustProxy: TrustProxyMode): string | undefined {
  // "loopback" lets Express resolve req.ip from hops appended by a local proxy;
  // reading raw forwarding headers here would re-trust client-supplied values.
  if (trustProxy === true) {
    const cfConnectingIp = firstHeaderValue(req.header("cf-connecting-ip"));
    if (cfConnectingIp) return cfConnectingIp;

    const forwardedFor = firstHeaderValue(req.header("x-forwarded-for"));
    if (forwardedFor) return forwardedFor;
  }

  return req.ip ?? req.socket.remoteAddress;
}

export function requestPath(req: Request): string {
  return req.path || req.url.split("?")[0] || req.url;
}

export function commandPreview(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function firstHeaderValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function formatPretty(entry: LogFields): string {
  const ts = String(entry.ts);
  const level = String(entry.level).toUpperCase();
  const event = String(entry.event);
  const rest = Object.entries(entry)
    .filter(([key, value]) => !["ts", "level", "event"].includes(key) && value !== undefined)
    .map(([key, value]) => `${key}=${formatPrettyValue(value)}`)
    .join(" ");

  return rest ? `${ts} ${level} ${event} ${rest}` : `${ts} ${level} ${event}`;
}

function formatPrettyValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

export function sanitizeDiagnosticError(message: string): string {
  return message
    .replace(/(https?:\/\/)[^:\s]+:[^@\s]+@/g, "$1[REDACTED]@")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[\w-]+|ghp_[\w]+|github_pat_[\w]+|xox[a-z]-[\w-]+|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/\b(password|passwd|token|secret|api_?key)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, "$1=[REDACTED]")
    .slice(0, 240);
}

export function diagnosticFailure(error: unknown, outputBearing = false): string {
  const name = error instanceof Error ? error.name.replace(/[^\w]/g, "").slice(0, 64) || "Error" : "Error";
  // Command adapters can embed arbitrary stdout/stderr anywhere in the message.
  if (outputBearing) return name;
  const message = error instanceof Error ? error.message : "Operation failed";
  return `${name}: ${sanitizeDiagnosticError(message.split(/\r?\n/, 1)[0] ?? "").slice(0, 160)}`;
}
