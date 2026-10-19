import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyOutputPolicy, maxOutputTokensForKind } from "../src/ai/outputPolicy.js";
import { modelForPlan, modelForRequest } from "../src/plans.js";

describe("output policy", () => {
  it("caps live assist lower than practice", () => {
    assert.equal(maxOutputTokensForKind("explain"), 8192);
    assert.equal(maxOutputTokensForKind("follow_up"), 8192);
    assert.equal(maxOutputTokensForKind("question"), 16000);
    assert.equal(maxOutputTokensForKind(null), 16000);
  });

  it("strips effort on explain even for Sonnet", () => {
    const body: Record<string, unknown> = {
      max_tokens: 16000,
      output_config: { effort: "low" },
    };
    applyOutputPolicy(body, "explain", "expert", "claude-sonnet-5-5");
    assert.equal(body.max_tokens, 8192);
    assert.equal(body.output_config, undefined);
  });

  it("keeps effort on expert practice when client sends it", () => {
    const body: Record<string, unknown> = {
      max_tokens: 99999,
      output_config: { effort: "low" },
    };
    applyOutputPolicy(body, "question", "expert", "claude-opus-5-5");
    assert.equal(body.max_tokens, 16000);
    assert.deepEqual(body.output_config, { effort: "low" });
  });

  it("strips modern params on Haiku practice", () => {
    const body: Record<string, unknown> = {
      output_config: { effort: "low" },
      fallbacks: "default",
    };
    applyOutputPolicy(body, "question", "free", "claude-haiku-4-5");
    assert.equal(body.output_config, undefined);
    assert.equal(body.fallbacks, undefined);
  });
});

describe("Phase 2 live assist routing", () => {
  it("uses MODEL_EXPLAIN for explain on every anthropic plan", () => {
    process.env.MODEL_EXPLAIN = "claude-sonnet-5-5";
    try {
      assert.equal(modelForRequest("free", { kind: "explain" }), "claude-sonnet-5-5");
      assert.equal(modelForRequest("expert", { kind: "follow_up" }), "claude-sonnet-5-5");
      assert.equal(modelForRequest("expert", { kind: "question" }), modelForPlan("expert"));
    } finally {
      delete process.env.MODEL_EXPLAIN;
    }
  });

  it("openrouter dev: MODEL_OPENROUTER for practice and live assist", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.MODEL_OPENROUTER = "cohere/north-mini-code:free";
    try {
      assert.equal(modelForRequest("essential", { kind: "question" }), "cohere/north-mini-code:free");
      assert.equal(modelForRequest("essential", { kind: "explain" }), "cohere/north-mini-code:free");
      assert.equal(modelForRequest("expert", { kind: "follow_up" }), "cohere/north-mini-code:free");
    } finally {
      delete process.env.AI_PROVIDER;
      delete process.env.MODEL_OPENROUTER;
    }
  });
});
