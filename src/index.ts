import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { accountSummary } from "./account.js";
import { aiProviderEnvName, isAiConfigured } from "./ai/provider.js";
import { auth } from "./auth/routes.js";
import { currentUser, SESSION_COOKIE } from "./auth/sessions.js";
import { billing } from "./billing/routes.js";
import { stripeWebhook } from "./billing/webhooks.js";
import { config } from "./config.js";
import { createLogger, newRequestId, runWithLogContext, serializeError, setLogFormat, setLogLevel } from "./logger.js";
import { adminChat, chat } from "./chat/routes.js";
import { runMigrations } from "./db/client.js";
import { AppError, UnauthorizedError, errorJson } from "./errors.js";
import { proxy } from "./proxy.js";
import { clientIp, rateLimited } from "./rateLimit.js";
import { recentUsage } from "./tokens.js";

export const app = new Hono();

app.use("*", async (c, next) => {
  const requestId = newRequestId(c.req.header("x-request-id"));
  await runWithLogContext({ requestId, method: c.req.method, path: c.req.path }, () => next());
  c.res.headers.set("x-request-id", requestId);
});

const ALLOWED_HEADERS = [
  "content-type",
  "x-api-key",
  "anthropic-version",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  "authorization",
  "x-interviewveil-session",
  "x-interviewveil-kind",
  "x-interviewveil-mode",
  "x-chat-token",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
  "x-stainless-helper",
  "x-stainless-helper-method",
].join(", ");

const webOrigin = new URL(config.webUrl).origin;
const apiOrigin = new URL(config.publicUrl).origin;

/**
 * CORS:
 * - The website (WEB_URL) may call with credentials (session cookie) — dashboard, pricing.
 * - Anyone else (the desktop app's webview) gets credential-less CORS; it authenticates
 *   with the `x-interviewveil-session` header, so cookies are never exposed cross-site.
 */
app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  const trusted = origin === webOrigin;
  const setCors = () => {
    if (!origin) return;
    c.header("access-control-allow-origin", trusted ? origin : "*");
    if (trusted) {
      c.header("access-control-allow-credentials", "true");
      c.header("vary", "Origin");
    }
  };
  if (c.req.method === "OPTIONS" && origin) {
    setCors();
    c.header("access-control-allow-methods", "GET, POST, OPTIONS");
    c.header(
      "access-control-allow-headers",
      c.req.header("access-control-request-headers") ?? ALLOWED_HEADERS,
    );
    c.header("access-control-max-age", "600");
    return c.body(null, 204);
  }
  await next();
  setCors();
});

// CSRF: cookie-authenticated form posts must come from the website or the API itself.
app.use("*", async (c, next) => {
  const usesCookie = (c.req.header("cookie") ?? "").includes(`${SESSION_COOKIE}=`);
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
  const exempt = c.req.path === "/webhooks/stripe" || Boolean(c.req.header("x-interviewveil-session"));
  const origin = c.req.header("origin");
  if (usesCookie && unsafe && !exempt && origin && origin !== webOrigin && origin !== apiOrigin) {
    return c.text("Cross-site request blocked", 403);
  }
  await next();
});

app.get("/health", (c) => c.json({ ok: true }));

/** Practice settings the server controls (the model is routed per plan). */
app.get("/config", (c) => c.json({ difficulty: config.difficulty }));

const httpLog = createLogger("http");
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const path = c.req.path;
  const status = c.res.status;
  const fields = { method: c.req.method, path, status, ms: Date.now() - start };
  const traced = path.startsWith("/v1/") || path.startsWith("/webhooks/") || path === "/account" || path === "/usage";
  if (status >= 500) httpLog.error("request", fields);
  else if (status >= 400 && traced) httpLog.warn("request", fields);
  else if (traced) httpLog.debug("request", fields);
});

/** Landing-page installer clicks (sendBeacon). No auth; rate-limited per IP. */
app.post("/public/download", async (c) => {
  const ip = clientIp(c.req.header("x-forwarded-for"));
  if (rateLimited(`download:${ip}`, 120, 60_000)) {
    return c.body(null, 429);
  }
  const body = (await c.req.json<{ platform?: string; path?: string }>().catch(() => null)) ?? {};
  httpLog.info("download", { platform: body.platform, path: body.path, ip });
  return c.body(null, 204);
});

app.get("/account", async (c) => {
  const user = await currentUser(c);
  if (!user) return errorJson(c, new UnauthorizedError());
  return c.json(await accountSummary(user.id));
});

app.get("/usage", async (c) => {
  const user = await currentUser(c);
  if (!user) return errorJson(c, new UnauthorizedError());
  const rows = await recentUsage(user.id, 50);
  return c.json(
    rows.map((row) => ({
      createdAt: row.createdAt,
      kind: row.kind,
      tokensSpent: row.tokensSpent,
    })),
  );
});

app.route("/auth", auth);
app.route("/billing", billing);
app.route("/chat", chat);
app.route("/admin/chat", adminChat);
app.post("/webhooks/stripe", stripeWebhook);
app.route("/", proxy);

// API only: the website lives on WEB_URL.
app.get("/", (c) => c.redirect(config.webUrl));
app.notFound((c) => c.json({ type: "error", error: { type: "not_found", message: "Not found" } }, 404));

const bootLog = createLogger("boot");

app.onError((err, c) => {
  if (err instanceof AppError) return errorJson(c, err);
  httpLog.error("unhandled error", { path: c.req.path, ...serializeError(err) });
  return errorJson(c, new AppError(500, "api_error", "Something went wrong."));
});

/** Start the HTTP server (`src/server.ts` calls this; tests import `app` directly). */
export async function start() {
  setLogLevel(config.logLevel);
  setLogFormat(config.logFormat);
  if (config.production && !config.brevoKey) {
    throw new Error("BREVO_API_KEY is required in production (password reset emails).");
  }
  const missing = [
    !isAiConfigured() && aiProviderEnvName(),
    !config.sttKey && "STT_API_KEY",
    !config.stripeSecret && "STRIPE_SECRET_KEY",
    config.stripeSecret && !config.stripeWebhookSecret && "STRIPE_WEBHOOK_SECRET",
    !config.google.clientId && "GOOGLE_CLIENT_ID",
    !config.github.clientId && "GITHUB_CLIENT_ID",
    config.adminEmails.length === 0 && "ADMIN_EMAILS (no one can answer support chats)",
  ].filter(Boolean);
  if (missing.length) bootLog.warn(`not configured: ${missing.join(", ")}`);

  await runMigrations();
  bootLog.info("migrations applied");
  serve({ fetch: app.fetch, port: config.port });
  bootLog.info(`listening on ${config.publicUrl} (port ${config.port}); website ${config.webUrl}`, {
    logLevel: config.logLevel,
    logFormat: config.logFormat,
  });
}
