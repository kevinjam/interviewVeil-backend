import { Hono, type Context } from "hono";
import { currentUser } from "../auth/sessions.js";
import { webLink } from "../config.js";
import { AppError, UnauthorizedError, errorJson } from "../errors.js";
import { PAID_PLANS, PLANS, formatPrice, isPaidPlan } from "../plans.js";
import { cancelSubscription, changePlan, createCheckout, portalUrl, resumeSubscription } from "./service.js";

export const billing = new Hono();

/** Requests from the web portal are forms; from the desktop app (session header) they're JSON. */
const wantsJson = (c: Context) =>
  Boolean(c.req.header("x-interviewveil-session")) ||
  (c.req.header("content-type") ?? "").includes("application/json");

async function input(c: Context): Promise<Record<string, string>> {
  if (wantsJson(c)) return ((await c.req.json().catch(() => ({}))) as Record<string, string> | null) ?? {};
  const body = await c.req.parseBody();
  return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : ""]));
}

function respond(c: Context, result: { url?: string; notice?: string }) {
  if (wantsJson(c)) return c.json(result);
  if (result.url) return c.redirect(result.url, 303);
  return c.redirect(webLink(`/dashboard?notice=${encodeURIComponent(result.notice ?? "")}`), 303);
}

function fail(c: Context, err: unknown) {
  const appErr =
    err instanceof AppError
      ? err
      : new AppError(502, "billing_error", "Billing request failed. Please try again.");
  if (!(err instanceof AppError)) console.error("billing error", err);
  if (wantsJson(c)) return errorJson(c, appErr);
  if (appErr instanceof UnauthorizedError) return c.redirect(webLink("/login?next=/pricing"), 303);
  return c.redirect(webLink(`/dashboard?error=${encodeURIComponent(appErr.message)}`), 303);
}

async function requireUser(c: Context) {
  const user = await currentUser(c);
  if (!user) throw new UnauthorizedError();
  return user;
}

/** Public plan catalog (prices are the source of truth in `plans.ts`). */
billing.get("/plans", (c) =>
  c.json(
    (["free", ...PAID_PLANS] as const).map((id) => ({
      id,
      name: PLANS[id].name,
      price: formatPrice(PLANS[id].priceCents),
      priceCents: PLANS[id].priceCents,
      tokensPerMonth: PLANS[id].tokensPerMonth,
      audioSecondsPerMonth: PLANS[id].audioSecondsPerMonth,
      tagline: PLANS[id].tagline,
    })),
  ),
);

/** Subscribe (no current subscription) or switch plans (existing subscriber). */
billing.post("/subscribe", async (c) => {
  try {
    const user = await requireUser(c);
    const { plan } = await input(c);
    if (!plan || !isPaidPlan(plan)) throw new AppError(400, "unknown_plan", "Choose a plan.");
    if (user.plan === "free") return respond(c, { url: await createCheckout(user, plan) });
    const result = await changePlan(user, plan);
    const notice =
      result.kind === "upgraded"
        ? `upgraded:${plan}`
        : result.kind === "downgrade_scheduled"
          ? `downgrade:${plan}`
          : `downgrade-cancelled`;
    return respond(c, { notice });
  } catch (e) {
    return fail(c, e);
  }
});

billing.post("/cancel", async (c) => {
  try {
    await cancelSubscription(await requireUser(c));
    return respond(c, { notice: "cancelled" });
  } catch (e) {
    return fail(c, e);
  }
});

billing.post("/resume", async (c) => {
  try {
    await resumeSubscription(await requireUser(c));
    return respond(c, { notice: "resumed" });
  } catch (e) {
    return fail(c, e);
  }
});

billing.post("/portal", async (c) => {
  try {
    return respond(c, { url: await portalUrl(await requireUser(c)) });
  } catch (e) {
    return fail(c, e);
  }
});
