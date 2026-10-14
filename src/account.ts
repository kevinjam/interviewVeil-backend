import { eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { subscriptions, users } from "./db/schema.js";
import { PLANS } from "./plans.js";
import { getAudioState } from "./audio.js";
import { getTokenState } from "./tokens.js";
import { isAdmin } from "./chat/routes.js";

/** Everything the app and portal show about an account. */
export async function accountSummary(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new Error(`user ${userId} not found`);
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
  const tokens = await getTokenState(userId);
  const audio = await getAudioState(userId);
  const plan = PLANS[tokens.plan];

  return {
    email: user.email,
    name: user.name,
    accountKey: `IV-${user.id.replace(/-/g, "").slice(0, 4).toUpperCase()}···${user.id.slice(-4).toUpperCase()}`,
    plan: tokens.plan,
    planName: plan.name,
    tokensLeft: tokens.balance,
    tokenAllowance: tokens.allowance,
    audioSecondsLeft: audio.balance,
    audioSecondsAllowance: audio.allowance,
    /** When the balance next resets (free: monthly; paid: next renewal). */
    resetsAt: tokens.periodEnd.toISOString(),
    subscription: sub
      ? {
          plan: sub.plan,
          planName: PLANS[sub.plan].name,
          status: sub.status,
          currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          pendingPlan: sub.pendingPlan,
          pendingPlanName: sub.pendingPlan ? PLANS[sub.pendingPlan].name : null,
        }
      : null,
    hasBillingAccount: Boolean(user.stripeCustomerId),
    /** Can answer support chats at /admin/chat. */
    isAdmin: isAdmin(user),
  };
}

export type AccountSummary = Awaited<ReturnType<typeof accountSummary>>;
