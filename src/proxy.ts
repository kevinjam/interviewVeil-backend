import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { stream } from "hono/streaming";
import { currentUser } from "./auth/sessions.js";
import { parseUpstreamError, upstreamErrorResponse } from "./ai/errors.js";
import { currentAiProvider, aiMessagesUpstream, isAiConfigured, lacksModernParams } from "./ai/provider.js";
import { config, MAX_OUTPUT_TOKENS } from "./config.js";
import { db } from "./db/client.js";
import { audioUsage, type User } from "./db/schema.js";
import { AppError, UnauthorizedError, errorJson } from "./errors.js";
import { rateLimited } from "./rateLimit.js";
import { refundAudioSeconds, reserveAudioSeconds } from "./audio.js";
import { createLogger, logUserId, patchLogContext, serializeError } from "./logger.js";
import { modelForRequest } from "./plans.js";
import { commitToken, refundToken, reserveToken } from "./tokens.js";

const log = createLogger("proxy");
const sttLog = createLogger("stt");

export const proxy = new Hono();

async function requireUser(c: Context): Promise<User> {
  const user = await currentUser(c);
  if (!user) throw new UnauthorizedError();
  if (rateLimited(`ai:${user.id}`, config.rateLimitPerMinute, 60_000)) {
    throw new AppError(429, "rate_limit_error", "Too many requests; slow down.");
  }
  return user;
}

const handle =
  (fn: (c: Context) => Promise<Response>) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof AppError) return errorJson(c, e);
      log.error("handler failed", serializeError(e));
      return errorJson(c, new AppError(502, "api_error", "The AI service is unavailable. Please try again."));
    }
  };

/**
 * Watches an Anthropic SSE stream: a response counts as successful only if it
 * reaches `message_stop` without an error event or a refusal.
 */
export class StreamOutcome {
  private buffer = "";
  completed = false;
  failed = false;
  inputTokens = 0;
  outputTokens = 0;
  /** Set when the provider sends an SSE `error` event. */
  errorMessage: string | null = null;

  feed(chunk: string) {
    this.buffer += chunk;
    const events = this.buffer.split("\n\n");
    this.buffer = events.pop() ?? "";
    for (const raw of events) this.handle(raw);
  }

  private handle(raw: string) {
    const data = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    if (!data) return;
    let evt: {
      type?: string;
      message?: { usage?: { input_tokens?: number } };
      delta?: { stop_reason?: string };
      usage?: { output_tokens?: number };
      error?: unknown;
    };
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    switch (evt.type) {
      case "message_start":
        this.inputTokens = evt.message?.usage?.input_tokens ?? 0;
        break;
      case "message_delta":
        if (evt.delta?.stop_reason === "refusal") this.failed = true;
        this.outputTokens = evt.usage?.output_tokens ?? this.outputTokens;
        break;
      case "message_stop":
        this.completed = true;
        break;
      case "error":
        this.failed = true;
        this.errorMessage = parseUpstreamError(502, JSON.stringify(evt.error ?? evt)).message;
        break;
    }
  }

  get succeeded() {
    return this.completed && !this.failed;
  }
}

/** Anthropic Messages API passthrough. The desktop app's SDK points its baseURL here. */
proxy.post(
  "/v1/messages",
  handle(async (c) => {
    const user = await requireUser(c);
    patchLogContext({ user: logUserId(user.id) });
    if (!isAiConfigured()) throw new AppError(503, "api_error", "The AI service isn't configured.");

    const body = (await c.req.json()) as Record<string, unknown>;
    // Hold one token now (atomic; blocks at 0). Charged on success, refunded on failure.
    const state = await reserveToken(user.id);
    const provider = currentAiProvider();

    // Model routing: Claude plan tier, or MODEL_OPENROUTER when AI_PROVIDER=openrouter.
    const mode = c.req.header("x-interviewveil-mode")?.slice(0, 32) ?? null;
    const requestModel = modelForRequest(state.plan, { mode });
    body.model = requestModel;
    body.max_tokens = Math.min(Number(body.max_tokens) || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
    const legacy = lacksModernParams(requestModel);
    if (legacy) {
      delete body.output_config;
      delete body.fallbacks;
    }
    const kind = c.req.header("x-interviewveil-kind")?.slice(0, 32) ?? null;

    const beta = (c.req.header("anthropic-beta") ?? "")
      .split(",")
      .map((b) => b.trim())
      .filter((b) => b && !(legacy && b.startsWith("server-side-fallback")))
      .join(",");
    const upstreamReq = aiMessagesUpstream(requestModel, {
      search: new URL(c.req.url).search,
      anthropicVersion: c.req.header("anthropic-version"),
      anthropicBeta: beta || null,
    });
    body.model = upstreamReq.model;
    log.info("AI request started", {
      user: logUserId(user.id),
      plan: state.plan,
      provider,
      model: upstreamReq.model,
      kind,
      tokensAfterReserve: state.balance,
    });

    let upstream: Response;
    try {
      upstream = await fetch(upstreamReq.url, {
        method: "POST",
        headers: upstreamReq.headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      await refundToken(user.id);
      log.error("AI upstream fetch failed", {
        provider,
        model: upstreamReq.model,
        host: safeHost(upstreamReq.url),
        ...serializeError(e),
      });
      throw new AppError(502, "api_error", "The AI service is unavailable. Please try again.");
    }

    if (!upstream.ok || !upstream.body) {
      await refundToken(user.id);
      const raw = await upstream.text();
      const { info, json } = upstreamErrorResponse(upstream.status, raw);
      log.error("AI upstream error", {
        provider,
        model: upstreamReq.model,
        host: safeHost(upstreamReq.url),
        status: upstream.status,
        type: info.type,
        code: info.code,
        vendor: info.provider,
        message: info.message,
        body: info.detail,
      });
      return new Response(json, {
        status: upstream.status,
        headers: { "content-type": "application/json" },
      });
    }

    const settle = async (ok: boolean, extra?: { inputTokens?: number; outputTokens?: number; reason?: string }) => {
      if (ok) {
        await commitToken(user.id, {
          plan: state.plan,
          model: upstreamReq.model,
          kind,
          inputTokens: extra?.inputTokens,
          outputTokens: extra?.outputTokens,
        });
        log.info("AI request committed", {
          user: logUserId(user.id),
          kind,
          model: upstreamReq.model,
          inputTokens: extra?.inputTokens,
          outputTokens: extra?.outputTokens,
        });
      } else {
        await refundToken(user.id);
        log.warn("AI request refunded", { user: logUserId(user.id), kind, model: upstreamReq.model, reason: extra?.reason });
      }
    };

    // Non-streaming request: success = 200 with a non-refusal stop reason.
    if (!(upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const text = await upstream.text();
      let json: { type?: string; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      try {
        json = JSON.parse(text) as typeof json;
      } catch (e) {
        await settle(false, { reason: "invalid_json" });
        log.error("AI upstream returned non-JSON", {
          provider,
          model: upstreamReq.model,
          body: text.slice(0, 2000),
          ...serializeError(e),
        });
        throw new AppError(502, "api_error", "The AI service returned an invalid response.");
      }
      if (json.type === "error") {
        const info = parseUpstreamError(200, text);
        await settle(false, { reason: info.message });
        log.error("AI upstream error in 200 body", {
          provider,
          model: upstreamReq.model,
          type: info.type,
          message: info.message,
          body: info.detail,
        });
        return new Response(JSON.stringify({ type: "error", error: { type: info.type, message: info.message } }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      const refused = json.stop_reason === "refusal";
      await settle(!refused, {
        inputTokens: json.usage?.input_tokens,
        outputTokens: json.usage?.output_tokens,
        reason: refused ? "refusal" : undefined,
      });
      return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
    }

    c.header("content-type", "text/event-stream");
    c.header("cache-control", "no-cache");
    const outcome = new StreamOutcome();
    const decoder = new TextDecoder();
    return stream(c, async (s) => {
      const reader = upstream.body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          outcome.feed(decoder.decode(value, { stream: true }));
          await s.write(value);
          if (s.aborted) break; // client went away: they never got the full answer
        }
      } catch (e) {
        log.error("stream relay failed", { model: upstreamReq.model, ...serializeError(e) });
      } finally {
        const reason = s.aborted
          ? "client_disconnected"
          : outcome.errorMessage
            ? outcome.errorMessage
            : outcome.failed
              ? "stream_error"
              : outcome.completed
                ? undefined
                : "incomplete_stream";
        await settle(outcome.succeeded && !s.aborted, {
          inputTokens: outcome.inputTokens,
          outputTokens: outcome.outputTokens,
          reason,
        }).catch((e) => log.error("token settle failed", serializeError(e)));
      }
    });
  }),
);

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

/** 16-bit mono WAV duration from its header; falls back to byte size at 16 kHz. */
function wavSeconds(buf: ArrayBuffer): number {
  const v = new DataView(buf);
  if (buf.byteLength > 44 && v.getUint32(0, false) === 0x52494646 /* RIFF */) {
    const byteRate = v.getUint32(28, true);
    if (byteRate > 0) return (buf.byteLength - 44) / byteRate;
  }
  return buf.byteLength / 32_000;
}

/**
 * Transcription passthrough. Billed in listening seconds (plan allowance), not AI tokens.
 */
proxy.post(
  "/v1/audio/transcriptions",
  handle(async (c) => {
    const user = await requireUser(c);
    patchLogContext({ user: logUserId(user.id) });
    if (!config.sttKey) throw new AppError(503, "api_error", "Transcription isn't configured.");

    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError(400, "invalid_request_error", "file is required");
    if (file.size > 10 * 1024 * 1024) throw new AppError(413, "invalid_request_error", "Audio segment too large.");
    const seconds = Math.max(1, Math.ceil(wavSeconds(await file.arrayBuffer())));
    sttLog.debug("transcription request", {
      user: logUserId(user.id),
      bytes: file.size,
      seconds,
      hasPrompt: Boolean(form.get("prompt")),
    });

    const audioState = await reserveAudioSeconds(user.id, seconds);

    const upstreamForm = new FormData();
    upstreamForm.append("file", file, "segment.wav");
    upstreamForm.append("model", config.sttModel);
    upstreamForm.append("response_format", "json");
    const prompt = form.get("prompt");
    if (typeof prompt === "string" && prompt) upstreamForm.append("prompt", prompt.slice(-800));

    let upstream: Response;
    try {
      upstream = await fetch(`${config.sttBaseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.sttKey}` },
        body: upstreamForm,
      });
    } catch (e) {
      await refundAudioSeconds(user.id, seconds);
      sttLog.error("transcription fetch failed", {
        user: logUserId(user.id),
        host: safeHost(config.sttBaseUrl),
        seconds,
        ...serializeError(e),
      });
      throw new AppError(502, "api_error", "Transcription is unavailable. Please try again.");
    }
    const text = await upstream.text();
    if (!upstream.ok) {
      await refundAudioSeconds(user.id, seconds);
      const info = parseUpstreamError(upstream.status, text);
      sttLog.error("transcription upstream error", {
        user: logUserId(user.id),
        host: safeHost(config.sttBaseUrl),
        status: upstream.status,
        seconds,
        type: info.type,
        code: info.code,
        message: info.message,
        body: info.detail,
      });
    } else {
      await db.insert(audioUsage).values({ userId: user.id, seconds });
      let transcriptChars = 0;
      try {
        const parsed = JSON.parse(text) as { text?: string };
        transcriptChars = (parsed.text ?? "").length;
      } catch {
        /* non-json body */
      }
      sttLog.info("transcription ok", {
        user: logUserId(user.id),
        seconds,
        balanceAfter: audioState.balance,
        transcriptChars,
      });
    }
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }),
);
