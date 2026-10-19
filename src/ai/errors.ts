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

export type UserErrorContext = "ai" | "stt";

/** Safe copy for the desktop app — never expose vendor slugs or raw provider bodies. */
export function userFacingUpstreamMessage(info: UpstreamErrorInfo, ctx: UserErrorContext = "ai"): string {
  const type = info.type.toLowerCase();
  const m = info.message.toLowerCase();
  const status = info.status;

  if (type.includes("rate_limit") || status === 429 || m.includes("rate-limit") || m.includes("rate limited")) {
    return ctx === "stt"
      ? "Listening is busy right now. Wait a moment and try again."
      : "InterviewVeil is busy right now. Wait a moment and try again.";
  }

  if (type === "overloaded_error" || status === 529 || m.includes("overloaded")) {
    return "The AI coach is temporarily busy. Try again in a few seconds.";
  }

  if (
    m.includes("prompt is too long") ||
    m.includes("too many tokens") ||
    m.includes("context length") ||
    m.includes("maximum context")
  ) {
    return "That was too much to send at once. Use fewer screenshots or a shorter question.";
  }

  if (
    m.includes("does not support image") ||
    m.includes("image inputs") ||
    m.includes("multimodal") ||
    m.includes("vision")
  ) {
    return "We couldn't read this screenshot. Try again or contact support if it keeps happening.";
  }

  if (m.includes("agentic harness") || m.includes("permission_error") || type.includes("permission")) {
    return "We couldn't generate an answer right now. Try again in a little while.";
  }

  if (status === 401 || status === 403 || type.includes("authentication") || type.includes("auth")) {
    return "InterviewVeil couldn't reach the AI service. Try again later.";
  }

  if (status >= 500) {
    return ctx === "stt"
      ? "Transcription is temporarily unavailable. Please try again."
      : "The AI service is temporarily unavailable. Please try again.";
  }

  if (status === 400 || type.includes("invalid")) {
    return "We couldn't complete that request. Check your input and try again.";
  }

  return ctx === "stt"
    ? "We couldn't transcribe that audio. Please try again."
    : "We couldn't generate an answer. Please try again.";
}

export function toAnthropicErrorJson(info: UpstreamErrorInfo, ctx: UserErrorContext = "ai") {
  const message = userFacingUpstreamMessage(info, ctx);
  return { type: "error" as const, error: { type: "api_error" as const, message } };
}

export function upstreamErrorResponse(
  status: number,
  body: string,
  ctx: UserErrorContext = "ai",
): { info: UpstreamErrorInfo; json: string } {
  const info = parseUpstreamError(status, body);
  return { info, json: JSON.stringify(toAnthropicErrorJson(info, ctx)) };
}

/** Rewrite SSE `error` events so streamed failures use InterviewVeil copy. */
export function sanitizeSseErrorEvents(chunk: string, ctx: UserErrorContext = "ai"): string {
  if (!chunk.includes("event:") && !chunk.includes("data:")) return chunk;

  const parts = chunk.split("\n\n");
  const out: string[] = [];

  for (const raw of parts) {
    if (!raw.trim()) continue;
    const lines = raw.split("\n");
    let eventType = "";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    const data = dataLines.join("\n");
    if (eventType === "error" && data) {
      let evt: { type?: string; error?: unknown };
      try {
        evt = JSON.parse(data) as { type?: string; error?: unknown };
      } catch {
        out.push(raw);
        continue;
      }
      const info = parseUpstreamError(502, JSON.stringify(evt.error ?? evt));
      const message = userFacingUpstreamMessage(info, ctx);
      const sanitized = JSON.stringify({ type: "error", error: { type: "api_error", message } });
      out.push(`event: error\ndata: ${sanitized}`);
      continue;
    }
    out.push(raw);
  }

  const joined = out.join("\n\n");
  return joined.endsWith("\n\n") || !chunk.endsWith("\n\n") ? joined : `${joined}\n\n`;
}
