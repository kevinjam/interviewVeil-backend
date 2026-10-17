import { currentAiProvider, openRouterModel } from "./ai/provider.js";
import { config } from "./config.js";
import type { PaidPlan, Plan } from "./db/schema.js";

export type ModelTier = "haiku" | "sonnet" | "opus";

export interface PlanDefinition {
  id: Plan;
  name: string;
  /** Monthly price in US cents. */
  priceCents: number;
  /** Tokens granted each period (1 token = 1 AI response). */
  tokensPerMonth: number;
  /** Transcription / listen allowance per billing period (seconds). */
  audioSecondsPerMonth: number;
  tier: ModelTier;
  /** Higher rank = more capable plan; used for upgrade/downgrade decisions. */
  rank: number;
  tagline: string;
}

export const PLANS: Record<Plan, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    priceCents: 0,
    tokensPerMonth: 3,
    audioSecondsPerMonth: 10 * 60,
    tier: "haiku",
    rank: 0,
    tagline: "Try InterviewVeil with a few practice answers.",
  },
  essential: {
    id: "essential",
    name: "Essential",
    priceCents: 1100,
    tokensPerMonth: 50,
    audioSecondsPerMonth: 60 * 60,
    tier: "haiku",
    rank: 1,
    tagline: "Steady weekly practice.",
  },
  professional: {
    id: "professional",
    name: "Professional",
    priceCents: 2400,
    tokensPerMonth: 160,
    audioSecondsPerMonth: 180 * 60,
    tier: "sonnet",
    rank: 2,
    tagline: "Daily practice with a stronger coach.",
  },
  expert: {
    id: "expert",
    name: "Expert",
    priceCents: 4400,
    tokensPerMonth: 500,
    audioSecondsPerMonth: 400 * 60,
    tier: "opus",
    rank: 3,
    tagline: "Maximum allowance for intensive prep.",
  },
};

export const PAID_PLANS: PaidPlan[] = ["essential", "professional", "expert"];

export const TIER_LABEL: Record<ModelTier, string> = {
  haiku: "Claude Haiku",
  sonnet: "Claude Sonnet",
  opus: "Claude Opus",
};

/**
 * The only place a model is chosen. Every AI request is routed through this,
 * so a plan can never reach a model above its tier.
 */
export function modelForPlan(plan: Plan): string {
  return config.models[PLANS[plan].tier];
}

/**
 * Upstream model for this request.
 * - anthropic (production): plan tier → MODEL_HAIKU / MODEL_SONNET / MODEL_OPUS
 * - openrouter (testing): MODEL_OPENROUTER for every plan (MODEL_* are left alone)
 */
export function modelForRequest(plan: Plan, _opts?: { mode?: string | null }): string {
  if (currentAiProvider() === "openrouter") {
    return openRouterModel() ?? modelForPlan(plan);
  }
  return modelForPlan(plan);
}

export function isPaidPlan(plan: string): plan is PaidPlan {
  return (PAID_PLANS as string[]).includes(plan);
}

/** Positive = upgrade, negative = downgrade, 0 = same plan. */
export function comparePlans(from: Plan, to: Plan): number {
  return PLANS[to].rank - PLANS[from].rank;
}

/** Stripe price lookup key for a paid plan (stable across environments). */
export function priceLookupKey(plan: PaidPlan): string {
  return `interviewveil_${plan}_monthly`;
}

export function planFromLookupKey(key: string | null | undefined): PaidPlan | null {
  const match = /^interviewveil_(essential|professional|expert)_monthly$/.exec(key ?? "");
  return (match?.[1] as PaidPlan | undefined) ?? null;
}

export function formatPrice(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}
