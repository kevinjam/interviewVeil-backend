import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type Stripe from "stripe";
import { config } from "../config.js";
import { db, type Tx } from "../db/client.js";
import { stripeEvents, subscriptions, users } from "../db/schema.js";
import { resetAudioForPeriod } from "../audio.js";
import { addMonths, resetForPeriod } from "../tokens.js";
import { LIVE_STATUSES } from "./service.js";
import { planFromPrice, stripe } from "./stripe.js";

const customerId = (c: string | { id: string } | null): string | null =>
  typeof c === "string" ? c : (c?.id ?? null);

async function findUserId(tx: Tx, customer: string | null, metadataUserId?: string): Promise<string | null> {
  if (customer) {
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.stripeCustomerId, customer));
    if (u) return u.id;
  }
  if (metadataUserId) {
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, metadataUserId));
    if (u) {
      if (customer) await tx.update(users).set({ stripeCustomerId: customer }).where(eq(users.id, u.id));
      return u.id;
    }
  }
  return null;
}

/**
 * Mirror a Stripe subscription into the database and set the user's effective
 * plan. Token balances are not touched here except when the subscription ends.
 */
export async function applySubscription(tx: Tx, sub: Stripe.Subscription): Promise<void> {
  const userId = await findUserId(tx, customerId(sub.customer), sub.metadata?.user_id);
  if (!userId) return console.warn(`stripe: no user for subscription ${sub.id}`);
  const plan = planFromPrice(sub.items.data[0]?.price);
  if (!plan) return console.warn(`stripe: subscription ${sub.id} has an unknown price`);

  const [existing] = await tx.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  const sameSub = existing?.stripeSubscriptionId === sub.id;
  // A downgrade is pending while a schedule is attached; it lands when the price changes.
  const pendingPlan = sameSub && sub.schedule && existing.pendingPlan !== plan ? existing.pendingPlan : null;

  const row = {
    stripeSubscriptionId: sub.id,
    plan,
    status: sub.status,
    currentPeriodStart: new Date(sub.current_period_start * 1000),
    currentPeriodEnd: new Date(sub.current_period_end * 1000),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    pendingPlan,
  };
  // Ignore stale events for an older subscription the user has since replaced.
  if (existing && !sameSub && LIVE_STATUSES.has(existing.status) && !LIVE_STATUSES.has(sub.status)) return;
  await tx
    .insert(subscriptions)
    .values({ userId, ...row })
    .onConflictDoUpdate({ target: subscriptions.userId, set: row });

  const [user] = await tx.select({ plan: users.plan }).from(users).where(eq(users.id, userId));
  if (LIVE_STATUSES.has(sub.status)) {
    if (user.plan !== plan) await tx.update(users).set({ plan }).where(eq(users.id, userId));
  } else if (sub.status !== "incomplete" && user.plan !== "free") {
    // Canceled / expired / unpaid: back to Free with a fresh monthly allowance.
    const now = new Date();
    await tx.update(users).set({ plan: "free" }).where(eq(users.id, userId));
    await resetForPeriod(tx, userId, "free", now, addMonths(now, 1));
    await resetAudioForPeriod(tx, userId, "free", now, addMonths(now, 1));
  }
}

/** First payment and each renewal: switch to the billed plan and reset tokens. */
export async function applyInvoicePaid(tx: Tx, invoice: Stripe.Invoice): Promise<void> {
  if (invoice.billing_reason !== "subscription_create" && invoice.billing_reason !== "subscription_cycle") {
    return; // proration invoices from upgrades are handled by changePlan
  }
  const line = invoice.lines.data.find((l) => l.price && planFromPrice(l.price));
  const plan = planFromPrice(line?.price);
  if (!line || !plan) return console.warn(`stripe: invoice ${invoice.id} has no InterviewVeil plan line`);

  const userId = await findUserId(tx, customerId(invoice.customer), invoice.subscription_details?.metadata?.user_id);
  if (!userId) return console.warn(`stripe: no user for invoice ${invoice.id}`);

  await tx.update(users).set({ plan }).where(eq(users.id, userId));
  const [existing] = await tx.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  if (existing) {
    await tx
      .update(subscriptions)
      .set({ plan, pendingPlan: existing.pendingPlan === plan ? null : existing.pendingPlan })
      .where(eq(subscriptions.userId, userId));
  }
  const periodStart = new Date(line.period.start * 1000);
  const periodEnd = new Date(line.period.end * 1000);
  await resetForPeriod(tx, userId, plan, periodStart, periodEnd);
  await resetAudioForPeriod(tx, userId, plan, periodStart, periodEnd);
}

/** Apply one verified event. Returns false if it was already processed. */
export async function processEvent(event: Stripe.Event): Promise<boolean> {
  // Network reads happen before the transaction.
  let sub: Stripe.Subscription | null = null;
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const id = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    if (session.mode === "subscription" && id) sub = await stripe().subscriptions.retrieve(id);
  }

  return db.transaction(async (tx) => {
    const [fresh] = await tx
      .insert(stripeEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing()
      .returning();
    if (!fresh) return false;

    switch (event.type) {
      case "checkout.session.completed":
        if (sub) await applySubscription(tx, sub);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await applySubscription(tx, event.data.object);
        break;
      case "invoice.paid":
        await applyInvoicePaid(tx, event.data.object);
        break;
    }
    return true;
  });
}

export async function stripeWebhook(c: Context) {
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(
      await c.req.text(),
      c.req.header("stripe-signature") ?? "",
      config.stripeWebhookSecret,
    );
  } catch (e) {
    return c.text(`Webhook signature verification failed: ${e instanceof Error ? e.message : e}`, 400);
  }
  try {
    const applied = await processEvent(event);
    return c.json({ received: true, duplicate: !applied });
  } catch (e) {
    console.error(`stripe webhook ${event.type} ${event.id} failed`, e);
    return c.text("Webhook processing failed", 500); // Stripe will retry
  }
}
