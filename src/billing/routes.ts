import { Hono, type Context } from "hono";
import { currentUser } from "../auth/sessions.js";
import { config, webLink } from "../config.js";
import { AppError, UnauthorizedError, errorJson } from "../errors.js";
import { PAID_PLANS, PLANS, formatPrice, isPaidPlan } from "../plans.js";
import { billingSummaryForUser } from "./summary.js";
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

function dashboardReturn(fields: Record<string, string>, notice?: string): string {
  const base = fields.return_to?.startsWith("/dashboard") ? fields.return_to : "/dashboard";
  if (!notice) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}notice=${encodeURIComponent(notice)}`;
}

function respond(c: Context, result: { url?: string; notice?: string }, fields: Record<string, string> = {}) {
  if (wantsJson(c)) return c.json(result);
  if (result.url) return c.redirect(result.url, 303);
  return c.redirect(webLink(dashboardReturn(fields, result.notice)), 303);
}

function fail(c: Context, err: unknown, fields: Record<string, string> = {}) {
  const appErr =
    err instanceof AppError
      ? err
      : new AppError(502, "billing_error", "Billing request failed. Please try again.");
  if (!(err instanceof AppError)) console.error("billing error", err);
  if (wantsJson(c)) return errorJson(c, appErr);
  if (appErr instanceof UnauthorizedError) return c.redirect(webLink("/login?next=/pricing"), 303);
  const base = fields.return_to?.startsWith("/dashboard") ? fields.return_to : "/dashboard/billing";
  const sep = base.includes("?") ? "&" : "?";
  return c.redirect(webLink(`${base}${sep}error=${encodeURIComponent(appErr.message)}`), 303);
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
      trialDays: id === "free" ? 0 : config.billingTrialDays,
    })),
  ),
);

/** Subscribe (no current subscription) or switch plans (existing subscriber). */
billing.get("/summary", async (c) => {
  try {
    return c.json(await billingSummaryForUser(await requireUser(c)));
  } catch (e) {
    return fail(c, e, {});
  }
});

billing.post("/subscribe", async (c) => {
  const fields = await input(c);
  try {
    const user = await requireUser(c);
    const { plan } = fields;
    if (!plan || !isPaidPlan(plan)) throw new AppError(400, "unknown_plan", "Choose a plan.");
    if (user.plan === "free") return respond(c, { url: await createCheckout(user, plan) }, fields);
    const result = await changePlan(user, plan);
    const notice =
      result.kind === "upgraded"
        ? `upgraded:${plan}`
        : result.kind === "downgrade_scheduled"
          ? `downgrade:${plan}`
          : `downgrade-cancelled`;
    return respond(c, { notice }, fields);
  } catch (e) {
    return fail(c, e, fields);
  }
});

billing.post("/cancel", async (c) => {
  const fields = await input(c);
  try {
    await cancelSubscription(await requireUser(c));
    return respond(c, { notice: "cancelled" }, fields);
  } catch (e) {
    return fail(c, e, fields);
  }
});

billing.post("/resume", async (c) => {
  const fields = await input(c);
  try {
    await resumeSubscription(await requireUser(c));
    return respond(c, { notice: "resumed" }, fields);
  } catch (e) {
    return fail(c, e, fields);
  }
});

billing.post("/portal", async (c) => {
  const fields = await input(c);
  try {
    const flow = fields.flow === "payment_method_update" ? "payment_method_update" : "default";
    return respond(
      c,
      {
        url: await portalUrl(await requireUser(c), {
          returnPath: fields.return_to,
          flow,
        }),
      },
      fields,
    );
  } catch (e) {
    return fail(c, e, fields);
  }
});
