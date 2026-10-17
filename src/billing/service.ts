import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { config, webLink } from "../config.js";
import { db } from "../db/client.js";
import { subscriptions, users, type PaidPlan, type User } from "../db/schema.js";
import { AppError } from "../errors.js";
import { comparePlans, PLANS } from "../plans.js";
import { grantUpgradeAudio } from "../audio.js";
import { grantUpgrade } from "../tokens.js";
import { portalConfiguration, priceIdFor, stripe } from "./stripe.js";

/** Statuses where the paid plan is in effect. */
export const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

async function ensureCustomer(user: User): Promise<string> {
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const customer = await stripe().customers.create({
    email: user.email,
    name: user.name ?? undefined,
    metadata: { user_id: user.id },
  });
  // Store before checkout so every webhook can find the user by customer id.
  const [updated] = await db
    .update(users)
    .set({ stripeCustomerId: customer.id })
    .where(eq(users.id, user.id))
    .returning();
  return updated.stripeCustomerId ?? customer.id;
}

async function currentSubscription(userId: string) {
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  return sub && LIVE_STATUSES.has(sub.status) ? sub : null;
}

/** First paid checkout only — returning subscribers are not offered another trial. */
async function trialDaysForCheckout(userId: string): Promise<number | undefined> {
  const days = config.billingTrialDays;
  if (days <= 0) return undefined;
  const [prior] = await db.select({ userId: subscriptions.userId }).from(subscriptions).where(eq(subscriptions.userId, userId));
  return prior ? undefined : days;
}

/** New subscriber: Stripe Checkout URL for `plan`. */
export async function createCheckout(user: User, plan: PaidPlan): Promise<string> {
  if (await currentSubscription(user.id)) {
    throw new AppError(409, "already_subscribed", "You already have a subscription — change plans from your dashboard.");
  }
  const trialDays = await trialDaysForCheckout(user.id);
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer: await ensureCustomer(user),
    line_items: [{ price: await priceIdFor(plan), quantity: 1 }],
    client_reference_id: user.id,
    subscription_data: {
      metadata: { user_id: user.id },
      ...(trialDays
        ? {
            trial_period_days: trialDays,
            trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
          }
        : {}),
    },
    allow_promotion_codes: true,
    success_url: webLink("/dashboard?checkout=success"),
    cancel_url: webLink("/pricing?checkout=cancelled"),
  });
  if (!session.url) throw new AppError(502, "checkout_failed", "Couldn't start checkout. Please try again.");
  return session.url;
}

/** Drop any scheduled plan change so the subscription can be edited directly. */
async function releaseSchedule(sub: Stripe.Subscription): Promise<void> {
  const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id;
  if (scheduleId) await stripe().subscriptionSchedules.release(scheduleId);
}

export type PlanChangeResult = { kind: "upgraded" | "downgrade_scheduled" | "downgrade_cancelled"; plan: PaidPlan };

/**
 * Existing subscriber switching plans.
 * - Upgrade: charged the prorated difference now; new model + new token allowance immediately.
 * - Downgrade: takes effect at the next billing cycle (Stripe subscription schedule).
 * - Choosing the current plan while a downgrade is pending cancels that downgrade.
 */
export async function changePlan(user: User, target: PaidPlan): Promise<PlanChangeResult> {
  const local = await currentSubscription(user.id);
  if (!local) throw new AppError(409, "no_subscription", "Subscribe to a plan first.");

  const sub = await stripe().subscriptions.retrieve(local.stripeSubscriptionId);
  const item = sub.items.data[0];
  const diff = comparePlans(local.plan, target);

  if (diff === 0) {
    if (!local.pendingPlan) throw new AppError(409, "same_plan", `You're already on ${PLANS[target].name}.`);
    await releaseSchedule(sub);
    await db.update(subscriptions).set({ pendingPlan: null }).where(eq(subscriptions.userId, user.id));
    return { kind: "downgrade_cancelled", plan: target };
  }

  if (diff > 0) {
    await releaseSchedule(sub);
    // Throws if the prorated charge fails, in which case nothing changes.
    await stripe().subscriptions.update(sub.id, {
      items: [{ id: item.id, price: await priceIdFor(target) }],
      proration_behavior: "always_invoice",
      payment_behavior: "error_if_incomplete",
      cancel_at_period_end: false,
      metadata: { user_id: user.id },
    });
    await db.transaction(async (tx) => {
      await tx.update(users).set({ plan: target }).where(eq(users.id, user.id));
      await tx
        .update(subscriptions)
        .set({ plan: target, pendingPlan: null, cancelAtPeriodEnd: false })
        .where(eq(subscriptions.userId, user.id));
      await grantUpgrade(tx, user.id, target);
      await grantUpgradeAudio(tx, user.id, target);
    });
    return { kind: "upgraded", plan: target };
  }

  // Downgrade at period end: phase 1 keeps the current price, phase 2 switches.
  if (sub.cancel_at_period_end) {
    await stripe().subscriptions.update(sub.id, { cancel_at_period_end: false });
  }
  const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id;
  const schedule = scheduleId
    ? await stripe().subscriptionSchedules.retrieve(scheduleId)
    : await stripe().subscriptionSchedules.create({ from_subscription: sub.id });
  const currentPhase = schedule.phases[0];
  await stripe().subscriptionSchedules.update(schedule.id, {
    end_behavior: "release",
    phases: [
      {
        items: [{ price: item.price.id, quantity: 1 }],
        start_date: currentPhase.start_date,
        end_date: sub.current_period_end,
      },
      { items: [{ price: await priceIdFor(target), quantity: 1 }], iterations: 1 },
    ],
    metadata: { user_id: user.id },
  });
  await db
    .update(subscriptions)
    .set({ pendingPlan: target, cancelAtPeriodEnd: false })
    .where(eq(subscriptions.userId, user.id));
  return { kind: "downgrade_scheduled", plan: target };
}

/** Cancel at the end of the paid period (keeps access until then). */
export async function cancelSubscription(user: User): Promise<void> {
  const local = await currentSubscription(user.id);
  if (!local) throw new AppError(409, "no_subscription", "You don't have an active subscription.");
  const sub = await stripe().subscriptions.retrieve(local.stripeSubscriptionId);
  await releaseSchedule(sub);
  await stripe().subscriptions.update(sub.id, { cancel_at_period_end: true });
  await db
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: true, pendingPlan: null })
    .where(eq(subscriptions.userId, user.id));
}

export async function resumeSubscription(user: User): Promise<void> {
  const local = await currentSubscription(user.id);
  if (!local?.cancelAtPeriodEnd) throw new AppError(409, "not_cancelling", "Your subscription isn't set to cancel.");
  await stripe().subscriptions.update(local.stripeSubscriptionId, { cancel_at_period_end: false });
  await db.update(subscriptions).set({ cancelAtPeriodEnd: false }).where(eq(subscriptions.userId, user.id));
}

export type PortalFlow = "default" | "payment_method_update";

/** Stripe customer portal (payment method update uses a focused portal flow). */
export async function portalUrl(
  user: User,
  opts: { returnPath?: string; flow?: PortalFlow } = {},
): Promise<string> {
  if (!user.stripeCustomerId) throw new AppError(404, "no_billing_account", "You haven't purchased a plan yet.");
  const returnPath = opts.returnPath?.startsWith("/dashboard") ? opts.returnPath : "/dashboard/billing";
  const params: Stripe.BillingPortal.SessionCreateParams = {
    customer: user.stripeCustomerId,
    configuration: await portalConfiguration(),
    return_url: webLink(returnPath),
  };
  if (opts.flow === "payment_method_update") {
    params.flow_data = { type: "payment_method_update" };
  }
  const session = await stripe().billingPortal.sessions.create(params);
  return session.url;
}
