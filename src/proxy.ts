import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { stream } from "hono/streaming";
import { currentUser } from "./auth/sessions.js";
import { config, MAX_OUTPUT_TOKENS } from "./config.js";
import { db } from "./db/client.js";
import { audioUsage, type User } from "./db/schema.js";
import { AppError, UnauthorizedError, errorJson } from "./errors.js";
import { rateLimited } from "./rateLimit.js";
import { refundAudioSeconds, reserveAudioSeconds } from "./audio.js";
import { createLogger, logUserId } from "./logger.js";
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
      log.error("handler failed", { error: e instanceof Error ? e.message : String(e) });
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
        break;
    }
  }

  get succeeded() {
    return this.completed && !this.failed;
  }
}

/** Haiku 4.5 supports neither `effort` nor server-side fallbacks. */
const lacksModernParams = (model: string) => model.startsWith("claude-haiku-4");

/** Anthropic Messages API passthrough. The desktop app's SDK points its baseURL here. */
proxy.post(
  "/v1/messages",
  handle(async (c) => {
    const user = await requireUser(c);
    if (!config.anthropicKey) throw new AppError(503, "api_error", "The AI service isn't configured.");

    const body = (await c.req.json()) as Record<string, unknown>;
    // Hold one token now (atomic; blocks at 0). Charged on success, refunded on failure.
    const state = await reserveToken(user.id);
    log.info("AI request started", {
      user: logUserId(user.id),
      plan: state.plan,
      model: state.model,
      kind: c.req.header("x-interviewveil-kind")?.slice(0, 32) ?? null,
      tokensAfterReserve: state.balance,
    });

    // Model routing: always the plan's model, whatever the client asked for.
    body.model = state.model;
    body.max_tokens = Math.min(Number(body.max_tokens) || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
    const legacy = lacksModernParams(state.model);
    if (legacy) {
      delete body.output_config;
      delete body.fallbacks;
    }
    const kind = c.req.header("x-interviewveil-kind")?.slice(0, 32) ?? null;

    const headers: Record<string, string> = {
      "x-api-key": config.anthropicKey,
      "anthropic-version": c.req.header("anthropic-version") ?? "2023-06-01",
      "content-type": "application/json",
    };
    if (config.anthropicWorkspaceId) {
      headers["anthropic-workspace-id"] = config.anthropicWorkspaceId;
    }
    const beta = (c.req.header("anthropic-beta") ?? "")
      .split(",")
      .map((b) => b.trim())
      .filter((b) => b && !(legacy && b.startsWith("server-side-fallback")))
      .join(",");
    if (beta) headers["anthropic-beta"] = beta;

    let upstream: Response;
    try {
      upstream = await fetch(`https://api.anthropic.com/v1/messages${new URL(c.req.url).search}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      await refundToken(user.id);
      throw e;
    }

    if (!upstream.ok || !upstream.body) {
      await refundToken(user.id);
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    }

    const settle = async (ok: boolean, inputTokens?: number, outputTokens?: number) => {
      if (ok) {
        await commitToken(user.id, { plan: state.plan, model: state.model, kind, inputTokens, outputTokens });
        log.info("AI request committed", {
          user: logUserId(user.id),
          kind,
          inputTokens,
          outputTokens,
        });
      } else {
        await refundToken(user.id);
        log.info("AI request refunded", { user: logUserId(user.id), kind });
      }
    };

    // Non-streaming request: success = 200 with a non-refusal stop reason.
    if (!(upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const text = await upstream.text();
      const json = JSON.parse(text) as {
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      await settle(json.stop_reason !== "refusal", json.usage?.input_tokens, json.usage?.output_tokens);
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
        log.error("stream relay failed", { error: e instanceof Error ? e.message : String(e) });
      } finally {
        await settle(outcome.succeeded && !s.aborted, outcome.inputTokens, outcome.outputTokens).catch((e) =>
          log.error("token settle failed", { error: e instanceof Error ? e.message : String(e) }),
        );
      }
    });
  }),
);

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

    const upstream = await fetch(`${config.sttBaseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.sttKey}` },
      body: upstreamForm,
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      await refundAudioSeconds(user.id, seconds);
      sttLog.warn("transcription upstream error", {
        user: logUserId(user.id),
        status: upstream.status,
        seconds,
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
