/**
 * Plan unit economics: revenue − variable API cost (Anthropic chat + OpenAI STT).
 * Run: npx tsx scripts/plan-unit-economics.ts
 *
 * Tweak ASSUMPTIONS below; prices from Anthropic/OpenAI list docs (Oct 2026).
 */

const PLANS = [
  { id: "free", priceUsd: 0, tokens: 3, listenMin: 10, model: "haiku55" as const },
  { id: "essential", priceUsd: 13, tokens: 50, listenMin: 40, model: "haiku55" as const },
  { id: "professional", priceUsd: 24, tokens: 160, listenMin: 180, model: "sonnet55" as const },
  { id: "expert", priceUsd: 44, tokens: 500, listenMin: 400, model: "opus55" as const },
] as const;

/** USD per 1M tokens (standard API, global). */
const ANTHROPIC = {
  haiku45: { in: 1.0, out: 5.0 },
  haiku55: { in: 0.1, out: 0.5 }, // prompts ≤100k tokens
  sonnet55: { in: 2.0, out: 10.0 },
  opus55: { in: 4.0, out: 20.0 },
} as const;

/** OpenAI gpt-4o-mini-transcribe estimated $/minute (OpenAI pricing table). */
const STT_USD_PER_MIN = 0.003;

const ASSUMPTIONS = {
  /** Share of AI responses that are screenshot / follow-up (heavier input). */
  liveAssistShare: 0.3,
  /** Tokens per practice response (input, output). */
  practice: { in: 3_000, out: 2_000 },
  /** Tokens per live-assist response (vision-heavy input). */
  liveAssist: { in: 15_000, out: 2_500 },
  /** Typical subscriber uses this fraction of monthly token + listen caps. */
  typicalUtilization: 0.5,
  /** Heavy subscriber uses this fraction (stress test). */
  maxUtilization: 1.0,
  /** Stripe ~2.9% + $0.30 per successful charge (paid plans only). */
  stripePercent: 0.029,
  stripeFixedUsd: 0.3,
};

type ModelKey = keyof typeof ANTHROPIC;

function aiCostPerResponse(model: ModelKey, kind: "practice" | "liveAssist"): number {
  const p = ANTHROPIC[model];
  const t = kind === "practice" ? ASSUMPTIONS.practice : ASSUMPTIONS.liveAssist;
  return (t.in / 1e6) * p.in + (t.out / 1e6) * p.out;
}

function blendedAiCostPerToken(model: ModelKey): number {
  const s = ASSUMPTIONS.liveAssistShare;
  return (1 - s) * aiCostPerResponse(model, "practice") + s * aiCostPerResponse(model, "liveAssist");
}

function monthCost(
  plan: (typeof PLANS)[number],
  util: number,
): { aiUsd: number; sttUsd: number; totalUsd: number; responses: number; listenMin: number } {
  const responses = plan.tokens * util;
  const listenMin = plan.listenMin * util;
  const aiUsd = responses * blendedAiCostPerToken(plan.model);
  const sttUsd = listenMin * STT_USD_PER_MIN;
  return { aiUsd, sttUsd, totalUsd: aiUsd + sttUsd, responses, listenMin };
}

function stripeFee(priceUsd: number): number {
  if (priceUsd <= 0) return 0;
  return priceUsd * ASSUMPTIONS.stripePercent + ASSUMPTIONS.stripeFixedUsd;
}

function fmt(n: number): string {
  return `$${n.toFixed(2)}`;
}

console.log("InterviewVeil — variable cost per user per month\n");
console.log("Assumptions:");
console.log(`  Live assist share of responses: ${ASSUMPTIONS.liveAssistShare * 100}%`);
console.log(
  `  Practice ~${ASSUMPTIONS.practice.in}/${ASSUMPTIONS.practice.out} tok; live assist ~${ASSUMPTIONS.liveAssist.in}/${ASSUMPTIONS.liveAssist.out} tok`,
);
console.log(`  STT: ${STT_USD_PER_MIN}/min (${ASSUMPTIONS.practice ? "gpt-4o-mini-transcribe" : ""})\n`);

for (const label of ["Typical (50% caps)", "Max (100% caps)"] as const) {
  const util = label.startsWith("Typical") ? ASSUMPTIONS.typicalUtilization : ASSUMPTIONS.maxUtilization;
  console.log(`=== ${label} ===\n`);
  console.log(
    "Plan          | Revenue | API chat | STT    | API total | Stripe* | Net after API+Stripe | Margin %",
  );
  console.log(
    "--------------|---------|----------|--------|-----------|---------|----------------------|----------",
  );
  for (const plan of PLANS) {
    const { aiUsd, sttUsd, totalUsd } = monthCost(plan, util);
    const stripe = stripeFee(plan.priceUsd);
    const net = plan.priceUsd - totalUsd - stripe;
    const marginPct = plan.priceUsd > 0 ? (net / plan.priceUsd) * 100 : 0;
    const name = plan.id.padEnd(13);
    console.log(
      `${name} | ${fmt(plan.priceUsd).padStart(7)} | ${fmt(aiUsd).padStart(8)} | ${fmt(sttUsd).padStart(6)} | ${fmt(totalUsd).padStart(9)} | ${fmt(stripe).padStart(7)} | ${fmt(net).padStart(20)} | ${marginPct.toFixed(0)}%`,
    );
  }
  console.log("\n* Stripe on subscription charge only; excludes infra, support, refunds.\n");
}

console.log("Per-response API cost (blended 70/30 practice/live):");
for (const [key, label] of [
  ["haiku55", "Haiku 5.5"],
  ["haiku45", "Haiku 4.5 (if still on MODEL_HAIKU)"],
  ["sonnet55", "Sonnet 5.5"],
  ["opus55", "Opus 5.5"],
] as const) {
  const c = blendedAiCostPerToken(key as ModelKey);
  console.log(`  ${label}: $${c.toFixed(4)}`);
}
