import type { Plan } from "../db/schema.js";
import { MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_LIVE_ASSIST } from "../config.js";
import { lacksModernParams } from "./provider.js";
import { usesServerLivePrompt } from "./request.js";

export function maxOutputTokensForKind(kind: string | null | undefined): number {
  return usesServerLivePrompt(kind ?? null) ? MAX_OUTPUT_TOKENS_LIVE_ASSIST : MAX_OUTPUT_TOKENS;
}

/**
 * Caps output length and applies effort/fallback rules:
 * - Live assist (explain / follow_up): tighter max_tokens; never low effort.
 * - Practice on Haiku: strip effort and fallbacks (unsupported).
 * - Practice on Sonnet/Opus (pro+): default low effort when client omits it.
 */
export function applyOutputPolicy(
  body: Record<string, unknown>,
  kind: string | null | undefined,
  plan: Plan,
  routedModel: string,
): void {
  const cap = maxOutputTokensForKind(kind);
  body.max_tokens = Math.min(Number(body.max_tokens) || cap, cap);

  const live = usesServerLivePrompt(kind ?? null);
  const legacy = lacksModernParams(routedModel);

  if (live) {
    stripEffort(body);
    return;
  }

  if (legacy) {
    delete body.output_config;
    delete body.fallbacks;
    return;
  }

  const proPlus = plan === "professional" || plan === "expert";
  if (proPlus && body.output_config == null) {
    body.output_config = { effort: "low" };
  }
}

function stripEffort(body: Record<string, unknown>): void {
  const raw = body.output_config;
  if (!raw || typeof raw !== "object") return;
  const oc = { ...(raw as Record<string, unknown>) };
  delete oc.effort;
  if (Object.keys(oc).length === 0) delete body.output_config;
  else body.output_config = oc;
}
