import Stripe from "stripe";
import { config } from "../config.js";
import type { PaidPlan } from "../db/schema.js";
import { AppError } from "../errors.js";
import { PAID_PLANS, planFromLookupKey, priceLookupKey } from "../plans.js";

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (!config.stripeSecret) throw new AppError(503, "billing_unavailable", "Billing isn't configured yet.");
  client ??= new Stripe(config.stripeSecret);
  return client;
}

export const stripeConfigured = () => Boolean(config.stripeSecret);

let priceCache: { at: number; prices: Map<PaidPlan, Stripe.Price> } | null = null;

/** Active monthly price for each paid plan, resolved by lookup key (cached 10 min). */
export async function planPrices(): Promise<Map<PaidPlan, Stripe.Price>> {
  if (priceCache && Date.now() - priceCache.at < 10 * 60_000) return priceCache.prices;
  const list = await stripe().prices.list({
    lookup_keys: PAID_PLANS.map(priceLookupKey),
    active: true,
    limit: 10,
  });
  const prices = new Map<PaidPlan, Stripe.Price>();
  for (const price of list.data) {
    const plan = planFromLookupKey(price.lookup_key);
    if (plan) prices.set(plan, price);
  }
  priceCache = { at: Date.now(), prices };
  return prices;
}

export async function priceIdFor(plan: PaidPlan): Promise<string> {
  const price = (await planPrices()).get(plan);
  if (!price) {
    throw new AppError(503, "billing_unavailable", "Plans aren't set up in Stripe yet. Run `npm run stripe:setup`.");
  }
  return price.id;
}

export function planFromPrice(price: Pick<Stripe.Price, "lookup_key"> | null | undefined): PaidPlan | null {
  return planFromLookupKey(price?.lookup_key);
}

let portalConfigId: string | null = null;

/** The portal configuration created by `stripe:setup` (plan changes disabled there). */
export async function portalConfiguration(): Promise<string | undefined> {
  if (portalConfigId) return portalConfigId;
  const configs = await stripe().billingPortal.configurations.list({ active: true, limit: 100 });
  portalConfigId = configs.data.find((c) => c.metadata?.interviewveil === "portal")?.id ?? null;
  return portalConfigId ?? undefined;
}
