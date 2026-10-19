import { config } from "../config.js";

export const AI_PROVIDERS = ["anthropic", "openrouter"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Read at request time so tests and `.env` reloads can switch providers
 * without restarting the process graph.
 *
 * Default is Anthropic (production). Set `AI_PROVIDER=openrouter` for testing.
 */
export function currentAiProvider(): AiProvider {
  return oneOf(process.env.AI_PROVIDER?.toLowerCase(), AI_PROVIDERS, "anthropic");
}

export function isAiConfigured(): boolean {
  return currentAiProvider() === "openrouter"
    ? Boolean(process.env.OPENROUTER_API_KEY)
    : Boolean(config.anthropicKey);
}

export function aiProviderEnvName(): "OPENROUTER_API_KEY" | "ANTHROPIC_API_KEY" {
  return currentAiProvider() === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY";
}

/**
 * OpenRouter expects `provider/model` slugs. Production Anthropic IDs
 * (`claude-haiku-4-5`) still work in test: we prefix `anthropic/` when
 * the slug has no vendor.
 */
/** One OpenRouter slug for all chat in dev when `AI_PROVIDER=openrouter` (practice + live assist). */
export function openRouterModel(): string | undefined {
  const slug = process.env.MODEL_OPENROUTER?.trim() || process.env.MODEL_OPEN_ROUTER?.trim();
  return slug || undefined;
}

export function routeAiModel(planModel: string): string {
  if (currentAiProvider() !== "openrouter") return planModel;
  return planModel.includes("/") ? planModel : `anthropic/${planModel}`;
}

/**
 * Haiku 4.x and non-Claude models do not support Anthropic `effort` / server-side fallbacks.
 * Sonnet and Opus keep those params.
 */
export function lacksModernParams(model: string): boolean {
  if (/(?:^|\/)claude-haiku-4/.test(model)) return true;
  return !/(?:^|\/)claude-(sonnet|opus)/.test(model);
}

export function aiMessagesUpstream(
  planModel: string,
  req: { search: string; anthropicVersion?: string | null; anthropicBeta?: string | null },
): { url: string; model: string; headers: Record<string, string> } {
  const model = routeAiModel(planModel);
  const search = req.search;
  const beta = req.anthropicBeta ?? "";

  if (currentAiProvider() === "openrouter") {
    const key = process.env.OPENROUTER_API_KEY ?? "";
    const base = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api").replace(/\/$/, "");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      "x-api-key": key,
      "anthropic-version": req.anthropicVersion || "2023-06-01",
      "content-type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER || config.webUrl,
      "X-Title": process.env.OPENROUTER_APP_TITLE || "InterviewVeil",
    };
    if (beta) headers["anthropic-beta"] = beta;
    return { url: `${base}/v1/messages${search}`, model, headers };
  }

  const headers: Record<string, string> = {
    "x-api-key": config.anthropicKey,
    "anthropic-version": req.anthropicVersion || "2023-06-01",
    "content-type": "application/json",
  };
  if (config.anthropicWorkspaceId) headers["anthropic-workspace-id"] = config.anthropicWorkspaceId;
  if (beta) headers["anthropic-beta"] = beta;
  return { url: `https://api.anthropic.com/v1/messages${search}`, model, headers };
}
