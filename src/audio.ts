import { and, eq, gte, sql } from "drizzle-orm";
import { db, type Tx } from "./db/client.js";
import { audioBalances, users, type Plan } from "./db/schema.js";
import { InsufficientAudioSecondsError } from "./errors.js";
import { createLogger, logUserId } from "./logger.js";
import { PLANS } from "./plans.js";
import { addMonths } from "./tokens.js";

const log = createLogger("audio");

export interface AudioState {
  plan: Plan;
  balance: number;
  allowance: number;
  periodStart: Date;
  periodEnd: Date;
}

function nextFreePeriod(start: Date, now: Date): { start: Date; end: Date } {
  let s = start;
  let e = addMonths(s, 1);
  for (let i = 0; e <= now && i < 1200; i++) {
    s = e;
    e = addMonths(s, 1);
  }
  return { start: s, end: e };
}

/** Create the listening balance row for a new user (same period as token balance). */
export async function createAudioBalance(tx: Tx, userId: string, now = new Date()): Promise<void> {
  const allowance = PLANS.free.audioSecondsPerMonth;
  await tx
    .insert(audioBalances)
    .values({
      userId,
      balance: allowance,
      allowance,
      periodStart: now,
      periodEnd: addMonths(now, 1),
    })
    .onConflictDoNothing();
}

/** Current listening balance; free plan resets lazily when the period has passed. */
export async function getAudioState(userId: string, now = new Date()): Promise<AudioState> {
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ plan: users.plan }).from(users).where(eq(users.id, userId));
    if (!user) throw new Error(`user ${userId} not found`);

    let [row] = await tx
      .select()
      .from(audioBalances)
      .where(eq(audioBalances.userId, userId))
      .for("update");
    if (!row) {
      await createAudioBalance(tx, userId, now);
      [row] = await tx.select().from(audioBalances).where(eq(audioBalances.userId, userId));
    }

    if (user.plan === "free" && row.periodEnd <= now) {
      const period = nextFreePeriod(row.periodEnd, now);
      const allowance = PLANS.free.audioSecondsPerMonth;
      [row] = await tx
        .update(audioBalances)
        .set({
          balance: allowance,
          allowance,
          periodStart: period.start,
          periodEnd: period.end,
        })
        .where(eq(audioBalances.userId, userId))
        .returning();
    }

    return {
      plan: user.plan,
      balance: row.balance,
      allowance: row.allowance,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
    };
  });
}

/** Atomically hold transcribed seconds before calling the STT upstream. */
export async function reserveAudioSeconds(userId: string, seconds: number): Promise<AudioState> {
  const state = await getAudioState(userId);
  if (seconds <= 0) return state;
  const [row] = await db
    .update(audioBalances)
    .set({ balance: sql`${audioBalances.balance} - ${seconds}` })
    .where(and(eq(audioBalances.userId, userId), gte(audioBalances.balance, seconds)))
    .returning({ balance: audioBalances.balance });
  if (!row) {
    log.warn("reserve failed: insufficient seconds", {
      user: logUserId(userId),
      requested: seconds,
      balance: state.balance,
    });
    throw new InsufficientAudioSecondsError();
  }
  log.info("reserved listening seconds", {
    user: logUserId(userId),
    seconds,
    balanceAfter: row.balance,
    plan: state.plan,
  });
  return { ...state, balance: row.balance };
}

/** Return seconds when transcription failed after a reserve. */
export async function refundAudioSeconds(userId: string, seconds: number): Promise<void> {
  if (seconds <= 0) return;
  const [row] = await db
    .update(audioBalances)
    .set({ balance: sql`${audioBalances.balance} + ${seconds}` })
    .where(eq(audioBalances.userId, userId))
    .returning({ balance: audioBalances.balance });
  log.info("refunded listening seconds", {
    user: logUserId(userId),
    seconds,
    balanceAfter: row?.balance,
  });
}

export async function resetAudioForPeriod(
  tx: Tx,
  userId: string,
  plan: Plan,
  periodStart: Date,
  periodEnd: Date,
): Promise<void> {
  const allowance = PLANS[plan].audioSecondsPerMonth;
  await tx
    .insert(audioBalances)
    .values({ userId, balance: allowance, allowance, periodStart, periodEnd })
    .onConflictDoUpdate({
      target: audioBalances.userId,
      set: { balance: allowance, allowance, periodStart, periodEnd },
    });
}

/** Upgrade mid-cycle: add the new plan's listening allowance on top of what's left. */
export async function grantUpgradeAudio(tx: Tx, userId: string, plan: Plan): Promise<void> {
  const allowance = PLANS[plan].audioSecondsPerMonth;
  await tx
    .update(audioBalances)
    .set({ balance: sql`${audioBalances.balance} + ${allowance}`, allowance })
    .where(eq(audioBalances.userId, userId));
}
