import type { AiKind, InterviewMode, InterviewRequestMeta } from "./request.js";
import { usesServerLivePrompt } from "./request.js";

const MODE_LABEL: Record<InterviewMode, string> = {
  coding: "coding (algorithms and data structures)",
  system_design: "system design",
  behavioral: "behavioral / leadership",
};

export type LivePromptInput = Pick<InterviewRequestMeta, "mode" | "language" | "answerLanguage" | "customPrompt"> & {
  kind: AiKind | string;
};

const OUTPUT_RULES = `Output rules (strict):
- Write only the sections below — no preamble, no postscript.
- Never show your reasoning process. Forbidden phrases include: "Wait", "Actually", "Let me re-read", "Looking at the image", "Box 1", "I notice", "Hmm".
- Do not number long essays (no "1. … 2. Formulate the algorithm …" unless the user explicitly asked in custom instructions).
- Keep prose short: Thoughts ≤ 3 bullets; each bullet ≤ 20 words.
- If the screenshot shows a compile error or wrong signature, fix it in Code without narrating the debugging.
- Do not mention AI, screenshots, or transcription.`;

function modeLabel(mode: InterviewMode | string | null): string {
  if (mode && mode in MODE_LABEL) return MODE_LABEL[mode as InterviewMode];
  return mode?.trim() || "coding (algorithms and data structures)";
}

function withCustom(base: string, input: LivePromptInput): string {
  const parts = [base];
  const lang = input.answerLanguage?.trim();
  if (lang && lang.toLowerCase() !== "english") {
    parts.push(
      `Write everything in ${lang}, except code, identifiers, and the section headings, which stay in English.`,
    );
  }
  const extra = input.customPrompt?.trim();
  if (extra) parts.push(`The candidate's own instructions:\n${extra}`);
  return parts.join("\n\n");
}

function codingExplainBody(codeLang: string): string {
  return `Use exactly these Markdown sections, in this order:

## Thoughts (Say to interviewer)
2–3 bullet points the candidate can say while typing. Name the pattern and one key idea (e.g. sliding window). No step-by-step derivation.

## Code
One complete solution in ${codeLang} in a single fenced code block. Include imports and a workable main/entry if the problem expects it. Handle empty input and obvious edge cases.

## Complexity
One line only: Time O(…) and space O(…) with brief labels (e.g. "Time O(n), space O(1) — window map").`;
}

function codingFollowUpBody(codeLang: string): string {
  return `The user message is a follow-up from the interviewer (often transcribed). Answer in as few words as possible.

If a short spoken reply is enough, use only:
## Thoughts (Say to interviewer)
1–2 bullets.

If code must change, add:
## Code
Only the changed or added ${codeLang} in one fenced block (or a minimal full class if clearer).

Do not repeat the full solution unless the follow-up requires it.`;
}

function systemDesignBody(): string {
  return `Use these sections (keep each bullet short):

## Thoughts (Say to interviewer)
2–3 bullets: requirements, scale, and your approach.

## Design
Components, APIs, and data flow — bullets or a tight outline, not an essay.

## Tradeoffs
2–3 bullets on alternatives you'd mention out loud.`;
}

function behavioralBody(): string {
  return `Use these sections:

## Thoughts (Say to interviewer)
2–3 bullets: how you'd frame the story.

## Answer
STAR in 4–6 short lines total (Situation, Task, Action, Result).`;
}

/** Screenshot + live listen: Tech Screen–style concise answers (server-owned). */
export function liveAssistSystemPrompt(input: LivePromptInput): string {
  const mode = modeLabel(input.mode);
  const codeLang = input.language?.trim() || "python";
  const followUp = input.kind === "follow_up";

  const role = `You are InterviewVeil, a discreet live interview coach for ${mode} interviews.
The candidate is in a live interview and needs a scannable answer on a small overlay — like a professional interview copilot, not a tutor essay.`;

  let body: string;
  if (input.mode === "system_design") {
    body = systemDesignBody();
  } else if (input.mode === "behavioral") {
    body = behavioralBody();
  } else if (followUp) {
    body = codingFollowUpBody(codeLang);
  } else {
    body = codingExplainBody(codeLang);
  }

  return withCustom(`${role}\n\n${OUTPUT_RULES}\n\n${body}`, input);
}

export function applyServerSystemPrompt(
  body: Record<string, unknown>,
  meta: InterviewRequestMeta,
): void {
  if (!usesServerLivePrompt(meta.kind)) return;
  body.system = liveAssistSystemPrompt({ ...meta, kind: meta.kind ?? "explain" });
}
