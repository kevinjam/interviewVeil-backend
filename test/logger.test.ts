import "./env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseUpstreamError, sanitizeSseErrorEvents, userFacingUpstreamMessage } from "../src/ai/errors.js";
import { redact, serializeError } from "../src/logger.js";

describe("upstream error parsing", () => {
  it("unwraps OpenRouter Provider returned error", () => {
    const info = parseUpstreamError(
      400,
      JSON.stringify({
        error: {
          message: "Provider returned error",
          code: 400,
          metadata: {
            raw: JSON.stringify({ message: "model does not support images" }),
            provider_name: "Cohere",
          },
        },
      }),
    );
    assert.equal(info.message, "Cohere: model does not support images");
    assert.equal(info.provider, "Cohere");
    assert.equal(info.code, 400);
  });

  it("keeps Anthropic messages as-is", () => {
    const info = parseUpstreamError(
      529,
      JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }),
    );
    assert.equal(info.message, "busy");
    assert.equal(info.type, "overloaded_error");
  });

  it("reads OpenRouter metadata.raw on the root object", () => {
    const info = parseUpstreamError(
      429,
      JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Provider returned error", error_type: "rate_limit_exceeded" },
        metadata: {
          raw: "google/gemma-4-31b-it:free is temporarily rate-limited upstream.",
          provider_name: "Google AI Studio",
          remedy_hint: "Retry shortly.",
        },
      }),
    );
    assert.equal(info.message, "Google AI Studio: google/gemma-4-31b-it:free is temporarily rate-limited upstream. (Retry shortly.)");
    assert.equal(info.type, "rate_limit_error");
  });

  it("surfaces Inkling harness restriction from error.message", () => {
    const info = parseUpstreamError(
      403,
      JSON.stringify({
        type: "error",
        error: {
          type: "permission_error",
          message:
            "thinkingmachines/inkling:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps",
        },
      }),
    );
    assert.match(info.message, /agentic harnesses/);
    assert.equal(info.type, "permission_error");
  });
});

describe("user-facing upstream messages", () => {
  it("maps vendor rate limits to InterviewVeil copy", () => {
    const info = parseUpstreamError(
      429,
      JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Provider returned error" },
        metadata: {
          raw: "google/gemma-4-31b-it:free is temporarily rate-limited upstream.",
          provider_name: "Google AI Studio",
        },
      }),
    );
    assert.match(userFacingUpstreamMessage(info), /InterviewVeil is busy/);
    assert.match(info.message, /gemma-4-31b-it/);
  });

  it("sanitizes streamed SSE error events", () => {
    const chunk =
      'event: error\ndata: {"type":"error","error":{"type":"permission_error","message":"inkling:free is only available on agentic harnesses"}}\n\n';
    const out = sanitizeSseErrorEvents(chunk);
    assert.doesNotMatch(out, /inkling/);
    assert.match(out, /couldn't generate an answer/i);
  });
});

describe("logger helpers", () => {
  it("redacts keys and API key prefixes", () => {
    const out = redact({
      Authorization: "Bearer sk-or-secret",
      model: "cohere/north-mini-code:free",
      note: "sk-or-v1-shouldhide",
    }) as Record<string, unknown>;
    assert.equal(out.Authorization, "[redacted]");
    assert.equal(out.model, "cohere/north-mini-code:free");
    assert.equal(out.note, "[redacted]");
  });

  it("serializes Error cause and code", () => {
    const err = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    err.cause = new Error("socket");
    const out = serializeError(err);
    assert.equal(out.message, "connect failed");
    assert.equal(out.code, "ECONNREFUSED");
    assert.equal((out.cause as { message: string }).message, "socket");
    assert.ok(typeof out.stack === "string");
  });
});
