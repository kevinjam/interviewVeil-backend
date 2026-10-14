import { and, eq, gt, sql } from "drizzle-orm";
import { db, type Tx } from "./db/client.js";
import { tokenBalances, usageHistory, users, type Plan } from "./db/schema.js";
import { InsufficientTokensError } from "./errors.js";
import { modelForPlan, PLANS } from "./plans.js";

export interface TokenState {
  plan: Plan;
  balance: number;
  allowance: number;
  periodStart: Date;
  periodEnd: Date;
  model: string;
}

/** Same day next month (clamped to month end, e.g. Jan 31 → Feb 28). */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** First free-plan period boundary after `now`, anchored on `start`. */
function nextFreePeriod(start: Date, now: Date): { start: Date; end: Date } {
  let s = start;
  let e = addMonths(s, 1);
  for (let i = 0; e <= now && i < 1200; i++) {
    s = e;
    e = addMonths(s, 1);
  }
  return { start: s, end: e };
}

/** Create the balance row for a new user (free plan, period starting now). */
export async function createBalance(tx: Tx, userId: string, now = new Date()): Promise<void> {
  await tx
    .insert(tokenBalances)
    .values({
      userId,
      balance: PLANS.free.tokensPerMonth,
      allowance: PLANS.free.tokensPerMonth,
      periodStart: now,
      periodEnd: addMonths(now, 1),
    })
    .onConflictDoNothing();
}

/**
 * Current plan, balance and model for a user. Free-plan balances reset
 * lazily here when their monthly period has passed; paid balances are reset
 * by Stripe's renewal webhook (`resetForPeriod`).
 */
export async function getTokenState(userId: string, now = new Date()): Promise<TokenState> {
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ plan: users.plan }).from(users).where(eq(users.id, userId));
    if (!user) throw new Error(`user ${userId} not found`);

    let [row] = await tx
      .select()
      .from(tokenBalances)
      .where(eq(tokenBalances.userId, userId))
      .for("update");
    if (!row) {
      await createBalance(tx, userId, now);
      [row] = await tx.select().from(tokenBalances).where(eq(tokenBalances.userId, userId));
    }

    if (user.plan === "free" && row.periodEnd <= now) {
      const period = nextFreePeriod(row.periodEnd, now);
      [row] = await tx
        .update(tokenBalances)
        .set({
          balance: PLANS.free.tokensPerMonth,
          allowance: PLANS.free.tokensPerMonth,
          periodStart: period.start,
          periodEnd: period.end,
        })
        .where(eq(tokenBalances.userId, userId))
        .returning();
    }

    return {
      plan: user.plan,
      balance: row.balance,
      allowance: row.allowance,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      model: modelForPlan(user.plan),
    };
  });
}

/** Throws `InsufficientTokensError` when the user has nothing left. */
export async function assertHasTokens(userId: string): Promise<TokenState> {
  const state = await getTokenState(userId);
  if (state.balance <= 0) throw new InsufficientTokensError();
  return state;
}

/**
 * Hold one token for an AI request that is about to start. The decrement is
 * atomic (`balance > 0` guard), so concurrent requests can never overspend.
 * Call `commitToken` once the response succeeds, or `refundToken` if it fails.
 */
export async function reserveToken(userId: string): Promise<TokenState> {
  const state = await getTokenState(userId);
  const [row] = await db
    .update(tokenBalances)
    .set({ balance: sql`${tokenBalances.balance} - 1` })
    .where(and(eq(tokenBalances.userId, userId), gt(tokenBalances.balance, 0)))
    .returning({ balance: tokenBalances.balance });
  if (!row) throw new InsufficientTokensError();
  return { ...state, balance: row.balance };
}

/** Record a successful AI response against the held token. */
export async function commitToken(
  userId: string,
  usage: { plan: Plan; model: string; kind?: string | null; inputTokens?: number; outputTokens?: number },
): Promise<void> {
  await db.insert(usageHistory).values({
    userId,
    plan: usage.plan,
    model: usage.model,
    tokensSpent: 1,
    kind: usage.kind ?? null,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
  });
}

/** Return a held token when the AI request failed. */
export async function refundToken(userId: string): Promise<void> {
  await db
    .update(tokenBalances)
    .set({ balance: sql`${tokenBalances.balance} + 1` })
    .where(eq(tokenBalances.userId, userId));
}

/** New billing period on `plan`: balance becomes that plan's full allowance. */
export async function resetForPeriod(
  tx: Tx,
  userId: string,
  plan: Plan,
  periodStart: Date,
  periodEnd: Date,
): Promise<void> {
  const allowance = PLANS[plan].tokensPerMonth;
  await tx
    .insert(tokenBalances)
    .values({ userId, balance: allowance, allowance, periodStart, periodEnd })
    .onConflictDoUpdate({
      target: tokenBalances.userId,
      set: { balance: allowance, allowance, periodStart, periodEnd },
    });
}

/** Upgrade mid-cycle: add the new plan's allowance on top of what's left. */
export async function grantUpgrade(tx: Tx, userId: string, plan: Plan): Promise<void> {
  const allowance = PLANS[plan].tokensPerMonth;
  await tx
    .update(tokenBalances)
    .set({ balance: sql`${tokenBalances.balance} + ${allowance}`, allowance })
    .where(eq(tokenBalances.userId, userId));
}

export async function recentUsage(userId: string, limit = 20) {
  return db
    .select()
    .from(usageHistory)
    .where(eq(usageHistory.userId, userId))
    .orderBy(sql`${usageHistory.createdAt} desc`)
    .limit(limit);
}
