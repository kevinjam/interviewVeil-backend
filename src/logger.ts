/** Structured logging. LOG_LEVEL=debug|info|warn|error. LOG_FORMAT=pretty|json (json in production). */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "pretty" | "json";

export type LogContext = {
  requestId?: string;
  method?: string;
  path?: string;
  user?: string;
};

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY =
  /^(authorization|cookie|set-cookie|x-api-key|x-interviewveil-session|api[-_]?key|secret|password|passwd|access_token|refresh_token)$/i;

const als = new AsyncLocalStorage<LogContext>();

function configuredLevel(): LogLevel {
  const v = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return "info";
}

function configuredFormat(): LogFormat {
  const v = (process.env.LOG_FORMAT ?? "").toLowerCase();
  if (v === "json" || v === "pretty") return v;
  return process.env.NODE_ENV === "production" ? "json" : "pretty";
}

let minRank = RANK[configuredLevel()];
let format = configuredFormat();

export function setLogLevel(level: LogLevel): void {
  minRank = RANK[level];
}

export function setLogFormat(next: LogFormat): void {
  format = next;
}

export function newRequestId(incoming?: string | null): string {
  const v = incoming?.trim() ?? "";
  return /^[\w.-]{8,64}$/.test(v) ? v : randomUUID();
}

export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return als.run({ ...als.getStore(), ...ctx }, fn);
}

export function patchLogContext(patch: LogContext): void {
  const store = als.getStore();
  if (store) Object.assign(store, patch);
}

export function getLogContext(): LogContext {
  return als.getStore() ?? {};
}

/** Short, non-secret user id prefix for logs. */
export function logUserId(userId: string): string {
  return userId.replace(/-/g, "").slice(0, 8);
}

export function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: String(err) };
  const out: Record<string, unknown> = { name: err.name, message: err.message };
  if ("code" in err && err.code != null) out.code = (err as { code: unknown }).code;
  if ("cause" in err && err.cause != null) out.cause = serializeError(err.cause);
  if (err.stack) out.stack = err.stack.split("\n").slice(0, 8).join("\n");
  return out;
}

export function redact(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    if (/^(sk-|sk-or-|sk-ant-|Bearer\s)/i.test(value)) return "[redacted]";
    return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => redact(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      out[k] = redact(v, k);
    }
    return out;
  }
  return value;
}

function emit(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void {
  if (RANK[level] < minRank) return;
  const ts = new Date().toISOString();
  const ctx = als.getStore();
  const merged: Record<string, unknown> = {};
  if (ctx?.requestId) merged.requestId = ctx.requestId;
  if (ctx?.method) merged.method = ctx.method;
  if (ctx?.path) merged.path = ctx.path;
  if (ctx?.user) merged.user = ctx.user;
  if (fields) Object.assign(merged, fields);
  const safe = redact(merged) as Record<string, unknown>;

  if (format === "json") {
    const line = JSON.stringify({ ts, level, scope, msg: message, ...safe });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    return;
  }

  const extra = Object.keys(safe).length > 0 ? ` ${JSON.stringify(safe)}` : "";
  const line = `[${ts}] [${level}] [${scope}] ${message}${extra}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, fields?: Record<string, unknown>) => emit("debug", scope, message, fields),
    info: (message: string, fields?: Record<string, unknown>) => emit("info", scope, message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => emit("warn", scope, message, fields),
    error: (message: string, fields?: Record<string, unknown>) => emit("error", scope, message, fields),
  };
}
