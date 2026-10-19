import type { Context } from "hono";

export const AI_KINDS = ["question", "review", "explain", "follow_up"] as const;
export type AiKind = (typeof AI_KINDS)[number];

export const INTERVIEW_MODES = ["coding", "system_design", "behavioral"] as const;
export type InterviewMode = (typeof INTERVIEW_MODES)[number];

export type InterviewRequestMeta = {
  kind: AiKind | string | null;
  mode: InterviewMode | string | null;
  language: string | null;
  answerLanguage: string | null;
  customPrompt: string | null;
};

export function readInterviewHeaders(c: Context): InterviewRequestMeta {
  return {
    kind: c.req.header("x-interviewveil-kind")?.slice(0, 32) ?? null,
    mode: normalizeMode(c.req.header("x-interviewveil-mode")),
    language: c.req.header("x-interviewveil-language")?.slice(0, 32) ?? null,
    answerLanguage: c.req.header("x-interviewveil-answer-language")?.slice(0, 64) ?? null,
    customPrompt: c.req.header("x-interviewveil-custom-prompt")?.slice(0, 1500) ?? null,
  };
}

function normalizeMode(raw: string | undefined): InterviewMode | string | null {
  const v = raw?.trim().slice(0, 32) ?? "";
  if (!v) return null;
  return (INTERVIEW_MODES as readonly string[]).includes(v) ? (v as InterviewMode) : v;
}

export function usesServerLivePrompt(kind: string | null): boolean {
  return kind === "explain" || kind === "follow_up";
}
