import "./env.js";
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { createUser } from "../src/auth/users.js";
import { applyInvoicePaid, applySubscription, processEvent } from "../src/billing/webhooks.js";
import { db } from "../src/db/client.js";
import { subscriptions, tokenBalances, usageHistory, users } from "../src/db/schema.js";
import { InsufficientTokensError } from "../src/errors.js";
import { comparePlans, modelForPlan, modelForRequest, PLANS, priceLookupKey } from "../src/plans.js";
import { StreamOutcome } from "../src/proxy.js";
import { getAudioState } from "../src/audio.js";
import {
  addMonths,
  commitToken,
  getTokenState,
  grantUpgrade,
  refundToken,
  reserveToken,
} from "../src/tokens.js";
import { closeDb, resetDb } from "./setup.js";

beforeEach(resetDb);
after(closeDb);

const ts = (d: Date) => Math.floor(d.getTime() / 1000);

async function newUser(email = "ada@example.com") {
  const user = await createUser({ email });
  await db.update(users).set({ stripeCustomerId: `cus_${user.id.slice(0, 8)}` }).where(eq(users.id, user.id));
  return { ...user, stripeCustomerId: `cus_${user.id.slice(0, 8)}` };
}

function fakeSubscription(customer: string, plan: "essential" | "professional" | "expert", over: Partial<Stripe.Subscription> = {}) {
  const start = new Date("2026-10-01T00:00:00Z");
  return {
    id: "sub_1",
    object: "subscription",
    customer,
    status: "active",
    cancel_at_period_end: false,
    current_period_start: ts(start),
    current_period_end: ts(addMonths(start, 1)),
    schedule: null,
    metadata: {},
    items: { data: [{ id: "si_1", price: { id: `price_${plan}`, lookup_key: priceLookupKey(plan) } }] },
    ...over,
  } as unknown as Stripe.Subscription;
}

function fakeInvoice(
  customer: string,
  plan: "essential" | "professional" | "expert",
  reason: Stripe.Invoice.BillingReason,
  periodStart = new Date("2026-10-01T00:00:00Z"),
) {
  return {
    id: `in_${reason}`,
    object: "invoice",
    customer,
    billing_reason: reason,
    subscription_details: { metadata: {} },
    lines: {
      data: [
        {
          price: { id: `price_${plan}`, lookup_key: priceLookupKey(plan) },
          period: { start: ts(periodStart), end: ts(addMonths(periodStart, 1)) },
        },
      ],
    },
  } as unknown as Stripe.Invoice;
}

describe("plans and model routing", () => {
  it("routes each plan to its tier's model", () => {
    assert.equal(modelForPlan("free"), "claude-haiku-4-5");
    assert.equal(modelForPlan("essential"), "claude-haiku-4-5");
    assert.equal(modelForPlan("professional"), "claude-sonnet-5-5");
    assert.equal(modelForPlan("expert"), "claude-opus-5-5");
  });

  it("uses MODEL_OPENROUTER for all requests when AI_PROVIDER=openrouter", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.MODEL_OPENROUTER = "cohere/north-mini-code:free";
    try {
      assert.equal(modelForRequest("free"), "cohere/north-mini-code:free");
      assert.equal(modelForRequest("expert"), "cohere/north-mini-code:free");
      assert.equal(modelForRequest("free", { kind: "explain" }), "cohere/north-mini-code:free");
      assert.equal(modelForPlan("expert"), "claude-opus-5-5");
    } finally {
      delete process.env.AI_PROVIDER;
      delete process.env.MODEL_OPENROUTER;
    }
  });

  it("matches the published price list", () => {
    assert.deepEqual(
      Object.values(PLANS).map((p) => [p.id, p.priceCents, p.tokensPerMonth]),
      [
        ["free", 0, 3],
        ["essential", 1300, 50],
        ["professional", 2400, 160],
        ["expert", 4400, 500],
      ],
    );
  });

  it("orders plans for upgrades and downgrades", () => {
    assert.ok(comparePlans("essential", "expert") > 0);
    assert.ok(comparePlans("expert", "professional") < 0);
    assert.equal(comparePlans("professional", "professional"), 0);
  });
});

describe("token balance", () => {
  it("starts new users on Free with 3 tokens", async () => {
    const u = await newUser();
    const s = await getTokenState(u.id);
    assert.equal(s.plan, "free");
    assert.equal(s.balance, 3);
    assert.equal(s.model, "claude-haiku-4-5");
  });

  it("blocks at zero and never goes negative", async () => {
    const u = await newUser();
    for (let i = 0; i < 3; i++) await reserveToken(u.id);
    await assert.rejects(reserveToken(u.id), InsufficientTokensError);
    assert.equal((await getTokenState(u.id)).balance, 0);
  });

  it("can't be overspent by concurrent requests", async () => {
    const u = await newUser();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => reserveToken(u.id)));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
    assert.equal((await getTokenState(u.id)).balance, 0);
  });

  it("refunds a held token when the response fails", async () => {
    const u = await newUser();
    await reserveToken(u.id);
    await refundToken(u.id);
    assert.equal((await getTokenState(u.id)).balance, 3);
  });

  it("records usage on success", async () => {
    const u = await newUser();
    const s = await reserveToken(u.id);
    await commitToken(u.id, { plan: s.plan, model: s.model, kind: "review", inputTokens: 10, outputTokens: 20 });
    const rows = await db.select().from(usageHistory).where(eq(usageHistory.userId, u.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model, "claude-haiku-4-5");
    assert.equal(rows[0].tokensSpent, 1);
    assert.equal(rows[0].kind, "review");
  });

  it("resets Free monthly, on the original anchor day", async () => {
    const u = await newUser();
    for (let i = 0; i < 3; i++) await reserveToken(u.id);
    const anchor = new Date("2026-01-31T12:00:00Z");
    await db
      .update(tokenBalances)
      .set({ periodStart: anchor, periodEnd: addMonths(anchor, 1) })
      .where(eq(tokenBalances.userId, u.id));
    const s = await getTokenState(u.id, new Date("2026-04-05T00:00:00Z"));
    assert.equal(s.balance, 3);
    assert.equal(s.periodStart.toISOString(), "2026-03-28T12:00:00.000Z");
    assert.ok(s.periodEnd > new Date("2026-04-05T00:00:00Z"));
  });

  it("adds the new allowance on upgrade", async () => {
    const u = await newUser();
    await reserveToken(u.id); // 2 left
    await db.transaction((tx) => grantUpgrade(tx, u.id, "professional"));
    const [row] = await db.select().from(tokenBalances).where(eq(tokenBalances.userId, u.id));
    assert.equal(row.balance, 162);
    assert.equal(row.allowance, 160);
  });
});

describe("stripe webhooks", () => {
  it("trialing grants paid allowance before the first invoice", async () => {
    const u = await newUser();
    await db.transaction((tx) =>
      applySubscription(tx, fakeSubscription(u.stripeCustomerId, "essential", { status: "trialing" })),
    );
    const s = await getTokenState(u.id);
    assert.equal(s.plan, "essential");
    assert.equal(s.balance, 50);
    const audio = await getAudioState(u.id);
    assert.equal(audio.allowance, PLANS.essential.audioSecondsPerMonth);
    assert.equal(audio.balance, PLANS.essential.audioSecondsPerMonth);
  });

  it("incomplete subscription row does not block grants when checkout completes", async () => {
    const u = await newUser();
    await db.transaction((tx) =>
      applySubscription(tx, fakeSubscription(u.stripeCustomerId, "essential", { status: "incomplete" })),
    );
    assert.equal((await getTokenState(u.id)).balance, 3);
    assert.equal((await getAudioState(u.id)).allowance, PLANS.free.audioSecondsPerMonth);

    await db.transaction((tx) =>
      applySubscription(tx, fakeSubscription(u.stripeCustomerId, "essential", { status: "trialing" })),
    );
    assert.equal((await getTokenState(u.id)).balance, 50);
    assert.equal((await getAudioState(u.id)).allowance, PLANS.essential.audioSecondsPerMonth);
  });

  it("expired trial (canceled) returns the user to Free", async () => {
    const u = await newUser();
    await db.transaction((tx) =>
      applySubscription(tx, fakeSubscription(u.stripeCustomerId, "essential", { status: "trialing" })),
    );
    await db.transaction((tx) =>
      applySubscription(tx, fakeSubscription(u.stripeCustomerId, "essential", { status: "canceled" })),
    );
    const s = await getTokenState(u.id);
    assert.equal(s.plan, "free");
    assert.equal(s.balance, 3);
  });

  it("first payment activates the plan and its full allowance", async () => {
    const u = await newUser();
    await db.transaction(async (tx) => {
      await applySubscription(tx, fakeSubscription(u.stripeCustomerId, "essential"));
      await applyInvoicePaid(tx, fakeInvoice(u.stripeCustomerId, "essential", "subscription_create"));
    });
    const s = await getTokenState(u.id);
    assert.equal(s.plan, "essential");
    assert.equal(s.balance, 50);
    assert.equal(s.model, "claude-haiku-4-5");
  });

  it("renewal resets tokens to the allowance; proration invoices don't", async () => {
    const u = await newUser();
    await db.transaction((tx) => applyInvoicePaid(tx, fakeInvoice(u.stripeCustomerId, "professional", "subscription_create")));
    for (let i = 0; i < 5; i++) await reserveToken(u.id);
    await db.transaction((tx) => applyInvoicePaid(tx, fakeInvoice(u.stripeCustomerId, "professional", "subscription_update")));
    assert.equal((await getTokenState(u.id)).balance, 155);
    await db.transaction((tx) =>
      applyInvoicePaid(tx, fakeInvoice(u.stripeCustomerId, "professional", "subscription_cycle", new Date("2026-11-01T00:00:00Z"))),
    );
    const s = await getTokenState(u.id);
    assert.equal(s.balance, 160);
    assert.equal(s.periodEnd.toISOString(), "2026-12-01T00:00:00.000Z");
  });

  it("a scheduled downgrade lands at the next cycle", async () => {
    const u = await newUser();
    await db.transaction(async (tx) => {
      await applySubscription(tx, fakeSubscription(u.stripeCustomerId, "expert"));
      await applyInvoicePaid(tx, fakeInvoice(u.stripeCustomerId, "expert", "subscription_create"));
    });
    await db.update(subscriptions).set({ pendingPlan: "essential" }).where(eq(subscriptions.userId, u.id));

    // Schedule attached, still on Expert: pending plan is kept, model unchanged.
    await db.transaction((tx) =>
      applySubscription(tx, fakeSubscription(u.stripeCustomerId, "expert", { schedule: "sub_sched_1" } as never)),
    );
    let [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, u.id));
    assert.equal(sub.pendingPlan, "essential");
    assert.equal((await getTokenState(u.id)).model, "claude-opus-5-5");

    // Next cycle bills Essential.
    await db.transaction(async (tx) => {
      await applySubscription(tx, fakeSubscription(u.stripeCustomerId, "essential"));
      await applyInvoicePaid(tx, fakeInvoice(u.stripeCustomerId, "essential", "subscription_cycle", new Date("2026-11-01T00:00:00Z")));
    });
    [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, u.id));
    const s = await getTokenState(u.id);
    assert.equal(sub.pendingPlan, null);
    assert.equal(s.plan, "essential");
    assert.equal(s.balance, 50);
    assert.equal(s.model, "claude-haiku-4-5");
  });

  it("cancellation returns the user to Free", async () => {
    const u = await newUser();
    await db.transaction(async (tx) => {
      await applySubscription(tx, fakeSubscription(u.stripeCustomerId, "professional"));
      await applyInvoicePaid(tx, fakeInvoice(u.stripeCustomerId, "professional", "subscription_create"));
    });
    await db.transaction((tx) =>
      applySubscription(tx, fakeSubscription(u.stripeCustomerId, "professional", { status: "canceled" })),
    );
    const s = await getTokenState(u.id);
    assert.equal(s.plan, "free");
    assert.equal(s.balance, 3);
    assert.equal(s.model, "claude-haiku-4-5");
  });

  it("past_due keeps the plan while Stripe retries", async () => {
    const u = await newUser();
    await db.transaction((tx) => applySubscription(tx, fakeSubscription(u.stripeCustomerId, "expert", { status: "past_due" })));
    assert.equal((await getTokenState(u.id)).plan, "expert");
  });

  it("ignores a replayed event (no double reset)", async () => {
    const u = await newUser();
    const event = {
      id: "evt_renewal",
      type: "invoice.paid",
      data: { object: fakeInvoice(u.stripeCustomerId, "essential", "subscription_create") },
    } as unknown as Stripe.Event;
    assert.equal(await processEvent(event), true);
    for (let i = 0; i < 10; i++) await reserveToken(u.id);
    assert.equal(await processEvent(event), false);
    assert.equal((await getTokenState(u.id)).balance, 40);
  });
});

describe("stream outcome", () => {
  const sse = (type: string, extra: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;

  it("succeeds only on a complete, non-refused stream", () => {
    const ok = new StreamOutcome();
    const body = sse("message_start", { message: { usage: { input_tokens: 12 } } }) +
      sse("content_block_delta") +
      sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 34 } }) +
      sse("message_stop");
    // Feed in awkward chunk boundaries.
    for (let i = 0; i < body.length; i += 7) ok.feed(body.slice(i, i + 7));
    assert.equal(ok.succeeded, true);
    assert.equal(ok.inputTokens, 12);
    assert.equal(ok.outputTokens, 34);

    const refused = new StreamOutcome();
    refused.feed(sse("message_delta", { delta: { stop_reason: "refusal" } }) + sse("message_stop"));
    assert.equal(refused.succeeded, false);

    const cut = new StreamOutcome();
    cut.feed(sse("message_start") + sse("content_block_delta"));
    assert.equal(cut.succeeded, false);

    const errored = new StreamOutcome();
    errored.feed(sse("error", { error: { type: "overloaded_error" } }) + sse("message_stop"));
    assert.equal(errored.succeeded, false);
    assert.match(errored.errorMessage ?? "", /overloaded/);
  });
});
