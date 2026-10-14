/**
 * Creates (or updates) InterviewVeil's Stripe products, monthly prices and
 * customer-portal configuration. Safe to run repeatedly:
 *
 *   npm run stripe:setup
 */
import type Stripe from "stripe";
import { PAID_PLANS, PLANS, priceLookupKey } from "../plans.js";
import { stripe } from "./stripe.js";

async function findProduct(plan: string): Promise<Stripe.Product | undefined> {
  for await (const product of stripe().products.list({ limit: 100 })) {
    if (product.metadata?.interviewveil_plan === plan) return product;
  }
  return undefined;
}

async function ensurePlan(plan: (typeof PAID_PLANS)[number]) {
  const def = PLANS[plan];
  const lookupKey = priceLookupKey(plan);
  const description = `${def.tokensPerMonth} AI responses per month`;

  let product = await findProduct(plan);
  if (!product) {
    product = await stripe().products.create({
      name: `InterviewVeil ${def.name}`,
      description,
      metadata: { interviewveil_plan: plan },
    });
    console.log(`created product ${product.id} (${def.name})`);
  } else if (product.name !== `InterviewVeil ${def.name}` || product.description !== description || !product.active) {
    product = await stripe().products.update(product.id, { name: `InterviewVeil ${def.name}`, description, active: true });
  }

  const [existing] = (await stripe().prices.list({ lookup_keys: [lookupKey], limit: 1 })).data;
  const upToDate =
    existing?.active &&
    existing.unit_amount === def.priceCents &&
    existing.currency === "usd" &&
    existing.recurring?.interval === "month" &&
    existing.product === product.id;

  if (upToDate) {
    console.log(`✓ ${def.name}: ${existing.id} ($${def.priceCents / 100}/month)`);
    return;
  }
  // Prices are immutable: create a new one and move the lookup key to it.
  const price = await stripe().prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: def.priceCents,
    recurring: { interval: "month" },
    lookup_key: lookupKey,
    transfer_lookup_key: true,
    metadata: { interviewveil_plan: plan },
  });
  if (existing?.active) await stripe().prices.update(existing.id, { active: false });
  console.log(`✓ ${def.name}: created ${price.id} ($${def.priceCents / 100}/month)`);
}

async function ensurePortal() {
  const configs = await stripe().billingPortal.configurations.list({ limit: 100 });
  const existing = configs.data.find((c) => c.metadata?.interviewveil === "portal");
  const params = {
    business_profile: { headline: "Manage your InterviewVeil subscription" },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      customer_update: { enabled: true, allowed_updates: ["email", "address"] as ("email" | "address")[] },
      subscription_cancel: { enabled: true, mode: "at_period_end" as const },
      // Plan changes go through InterviewVeil so token allowances stay in sync.
      subscription_update: { enabled: false },
    },
    metadata: { interviewveil: "portal" },
  };
  if (existing) {
    await stripe().billingPortal.configurations.update(existing.id, params);
    console.log(`✓ portal configuration ${existing.id} updated`);
  } else {
    const created = await stripe().billingPortal.configurations.create(params);
    console.log(`✓ portal configuration ${created.id} created`);
  }
}

for (const plan of PAID_PLANS) await ensurePlan(plan);
await ensurePortal();
console.log("Stripe is ready.");
