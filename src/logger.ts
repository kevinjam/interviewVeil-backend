/** Structured console logging for the API. Set LOG_LEVEL=debug for more detail. */

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): LogLevel {
  const v = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return "info";
}

let minRank = RANK[configuredLevel()];

/** Call once at startup if config loads log level from env. */
export function setLogLevel(level: LogLevel): void {
  minRank = RANK[level];
}

function emit(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void {
  if (RANK[level] < minRank) return;
  const ts = new Date().toISOString();
  const extra =
    fields && Object.keys(fields).length > 0
      ? ` ${JSON.stringify(fields)}`
      : "";
  const line = `[${ts}] [${level}] [${scope}] ${message}${extra}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Short, non-secret user id prefix for logs. */
export function logUserId(userId: string): string {
  return userId.replace(/-/g, "").slice(0, 8);
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, fields?: Record<string, unknown>) => emit("debug", scope, message, fields),
    info: (message: string, fields?: Record<string, unknown>) => emit("info", scope, message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => emit("warn", scope, message, fields),
    error: (message: string, fields?: Record<string, unknown>) => emit("error", scope, message, fields),
  };
}
