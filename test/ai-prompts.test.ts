import "./env.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyServerSystemPrompt, liveAssistSystemPrompt } from "../src/ai/prompts.js";
import { readInterviewHeaders, usesServerLivePrompt } from "../src/ai/request.js";
import { modelForRequest } from "../src/plans.js";

describe("live assist prompts", () => {
  it("flags explain and follow_up for server prompts", () => {
    assert.equal(usesServerLivePrompt("explain"), true);
    assert.equal(usesServerLivePrompt("follow_up"), true);
    assert.equal(usesServerLivePrompt("question"), false);
  });

  it("builds Tech Screen–style coding screenshot prompt", () => {
    const text = liveAssistSystemPrompt({
      kind: "explain",
      mode: "coding",
      language: "java",
      answerLanguage: "Spanish",
      customPrompt: "Prefer sliding window.",
    });
    assert.match(text, /java/);
    assert.match(text, /Spanish/);
    assert.match(text, /sliding window/);
    assert.match(text, /## Thoughts \(Say to interviewer\)/);
    assert.match(text, /## Code/);
    assert.match(text, /## Complexity/);
    assert.doesNotMatch(text, /## Problem/);
    assert.doesNotMatch(text, /## Approach/);
    assert.match(text, /Forbidden phrases/);
    assert.match(text, /Wait/);
  });

  it("uses shorter follow-up schema for coding", () => {
    const text = liveAssistSystemPrompt({
      kind: "follow_up",
      mode: "coding",
      language: "python",
      answerLanguage: "English",
      customPrompt: "",
    });
    assert.match(text, /follow-up from the interviewer/);
    assert.match(text, /Do not repeat the full solution/);
  });

  it("replaces client system on explain requests", () => {
    const body: Record<string, unknown> = { system: "client should not win", messages: [] };
    applyServerSystemPrompt(body, {
      kind: "explain",
      mode: "coding",
      language: "go",
      answerLanguage: "English",
      customPrompt: "",
    });
    assert.notEqual(body.system, "client should not win");
    assert.match(String(body.system), /InterviewVeil/);
    assert.match(String(body.system), /## Code/);
  });

  it("leaves question/review system untouched", () => {
    const body: Record<string, unknown> = { system: "keep me", messages: [] };
    applyServerSystemPrompt(body, {
      kind: "question",
      mode: "coding",
      language: null,
      answerLanguage: null,
      customPrompt: null,
    });
    assert.equal(body.system, "keep me");
  });
});

describe("interview headers", () => {
  it("parses x-interviewveil-* headers", () => {
    const meta = readInterviewHeaders({
      req: {
        header: (name: string) =>
          ({
            "x-interviewveil-kind": "explain",
            "x-interviewveil-mode": "coding",
            "x-interviewveil-language": "typescript",
            "x-interviewveil-answer-language": "French",
            "x-interviewveil-custom-prompt": "Use two pointers when possible.",
          })[name],
      },
    } as import("hono").Context);
    assert.equal(meta.kind, "explain");
    assert.equal(meta.mode, "coding");
    assert.equal(meta.language, "typescript");
    assert.equal(meta.answerLanguage, "French");
    assert.equal(meta.customPrompt, "Use two pointers when possible.");
  });
});

describe("explain model routing", () => {
  it("routes explain to MODEL_EXPLAIN even on free plan", () => {
    process.env.MODEL_EXPLAIN = "claude-sonnet-5-5";
    try {
      assert.equal(modelForRequest("free", { kind: "explain" }), "claude-sonnet-5-5");
      assert.equal(modelForRequest("free", { kind: "question" }), "claude-haiku-4-5");
    } finally {
      delete process.env.MODEL_EXPLAIN;
    }
  });
});
