/** Parse Anthropic / OpenRouter / OpenAI-style error bodies for logs and the client. */

export type UpstreamErrorInfo = {
  status: number;
  type: string;
  message: string;
  provider?: string;
  code?: string | number;
  detail: string;
};

const GENERIC =
  /^(provider returned error|internal server error|bad gateway|service unavailable|an error occurred|error)$/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function nestedMessage(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    try {
      return nestedMessage(JSON.parse(trimmed)) ?? trimmed;
    } catch {
      return trimmed || undefined;
    }
  }
  const obj = asRecord(raw);
  if (!obj) return;
  const inner = asRecord(obj.error);
  return pickString(inner?.message, inner?.error, obj.message, obj.error, obj.msg);
}

export function parseUpstreamError(status: number, body: string): UpstreamErrorInfo {
  const detail = truncate(body.trim() || `(empty body, HTTP ${status})`, 2000);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      status,
      type: "api_error",
      message: truncate(detail, 300) || `Upstream error (${status})`,
      detail,
    };
  }

  const root = asRecord(parsed) ?? {};
  const err = asRecord(root.error) ?? root;
  // OpenRouter puts metadata on the root object, not always under error.
  const meta = asRecord(err.metadata) ?? asRecord(root.metadata);
  const fromNested = nestedMessage(meta?.raw ?? err.metadata ?? root.metadata);
  const topMessage = pickString(err.message, err.msg, root.message) ?? "";
  const provider = pickString(meta?.provider_name, meta?.provider);
  const remedy = pickString(meta?.remedy_hint);
  const type = String(pickString(err.type, typeof err.code === "string" ? err.code : undefined, root.type) ?? "api_error");
  const generic = !topMessage || GENERIC.test(topMessage);
  const fallback = type !== "api_error" ? type.replace(/_/g, " ") : `Upstream error (${status})`;
  let message: string;
  if (generic && fromNested) {
    message = provider ? `${provider}: ${fromNested}` : fromNested;
  } else {
    message = topMessage || fromNested || fallback;
  }
  if (remedy && !message.includes(remedy)) message = `${message} (${remedy})`;

  return {
    status,
    type,
    message: truncate(message, 500),
    provider,
    code: typeof err.code === "string" || typeof err.code === "number" ? err.code : undefined,
    detail,
  };
}

export function toAnthropicErrorJson(info: UpstreamErrorInfo) {
  return { type: "error" as const, error: { type: info.type, message: info.message } };
}

export function upstreamErrorResponse(status: number, body: string): { info: UpstreamErrorInfo; json: string } {
  const info = parseUpstreamError(status, body);
  return { info, json: JSON.stringify(toAnthropicErrorJson(info)) };
}
