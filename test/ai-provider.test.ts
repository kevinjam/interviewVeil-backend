import "./env.js";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  aiMessagesUpstream,
  aiProviderEnvName,
  currentAiProvider,
  isAiConfigured,
  lacksModernParams,
  routeAiModel,
} from "../src/ai/provider.js";

afterEach(() => {
  delete process.env.AI_PROVIDER;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.MODEL_OPENROUTER;
  delete process.env.MODEL_OPEN_ROUTER;
});

describe("AI provider switch", () => {
  it("defaults to Anthropic so production stays unchanged", () => {
    delete process.env.AI_PROVIDER;
    assert.equal(currentAiProvider(), "anthropic");
    assert.equal(aiProviderEnvName(), "ANTHROPIC_API_KEY");
    assert.equal(routeAiModel("claude-haiku-4-5"), "claude-haiku-4-5");
    const up = aiMessagesUpstream("claude-haiku-4-5", {
      search: "",
      anthropicVersion: "2023-06-01",
      anthropicBeta: "server-side-fallback-2026-07-01",
    });
    assert.equal(up.url, "https://api.anthropic.com/v1/messages");
    assert.equal(up.model, "claude-haiku-4-5");
    assert.equal(up.headers["x-api-key"], "test-key");
    assert.equal(up.headers["anthropic-workspace-id"], "wrkspc_test");
    assert.equal(up.headers.Authorization, undefined);
  });

  it("routes OpenRouter with Anthropic-compatible /v1/messages", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    assert.equal(currentAiProvider(), "openrouter");
    assert.equal(aiProviderEnvName(), "OPENROUTER_API_KEY");
    assert.equal(isAiConfigured(), true);
    process.env.MODEL_OPENROUTER = "cohere/north-mini-code:free";
    assert.equal(routeAiModel("claude-haiku-4-5"), "anthropic/claude-haiku-4-5");
    assert.equal(routeAiModel("openai/gpt-4.1-mini"), "openai/gpt-4.1-mini");

    const up = aiMessagesUpstream("claude-sonnet-5-5", { search: "?beta=true", anthropicVersion: null, anthropicBeta: null });
    assert.equal(up.url, "https://openrouter.ai/api/v1/messages?beta=true");
    assert.equal(up.model, "anthropic/claude-sonnet-5-5");
    assert.equal(up.headers.Authorization, "Bearer sk-or-test");
    assert.equal(up.headers["x-api-key"], "sk-or-test");
    assert.equal(up.headers["anthropic-workspace-id"], undefined);
    assert.equal(up.headers["X-Title"], "InterviewVeil");
  });

  it("treats unknown AI_PROVIDER as Anthropic", () => {
    process.env.AI_PROVIDER = "not-a-vendor";
    assert.equal(currentAiProvider(), "anthropic");
  });

  it("detects Haiku 4 on native IDs and OpenRouter slugs", () => {
    assert.equal(lacksModernParams("claude-haiku-4-5"), true);
    assert.equal(lacksModernParams("anthropic/claude-haiku-4.5"), true);
    assert.equal(lacksModernParams("claude-sonnet-5-5"), false);
    assert.equal(lacksModernParams("openai/gpt-4.1-mini"), true);
    assert.equal(lacksModernParams("cohere/north-mini-code:free"), true);
    assert.equal(lacksModernParams("anthropic/claude-sonnet-4.5"), false);
  });
});
