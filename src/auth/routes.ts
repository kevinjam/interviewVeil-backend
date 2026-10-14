import { randomInt } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { config, webLink } from "../config.js";
import { db } from "../db/client.js";
import { desktopLogins, passwordResets, users } from "../db/schema.js";
import { sendPasswordReset } from "../email.js";
import { clientIp, rateLimited } from "../rateLimit.js";
import { accountSummary } from "../account.js";
import { finishOAuth, isProvider, providerEnabled, safeNext, startOAuth } from "./oauth.js";
import { hashPassword, passwordProblem, verifyPassword } from "./password.js";
import {
  clearSessionCookie,
  createSession,
  currentUser,
  deleteAllSessions,
  deleteSession,
  randomToken,
  sessionToken,
  setSessionCookie,
  sha256,
} from "./sessions.js";
import { createUser, findUserByEmail, normalizeEmail, upsertOAuthUser } from "./users.js";

export const auth = new Hono();

/** Redirect back to a web form with a message. */
function back(c: Context, path: string, params: Record<string, string>) {
  const url = new URL(webLink(path));
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  return c.redirect(url.toString(), 303);
}

async function form(c: Context): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  return Object.fromEntries(
    Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : ""]),
  );
}

// ---- email + password ---------------------------------------------------------

auth.post("/signup", async (c) => {
  const f = await form(c);
  const next = safeNext(f.next);
  const email = normalizeEmail(f.email ?? "");
  if (rateLimited(`signup:${clientIp(c.req.header("x-forwarded-for"))}`, 10, 60 * 60_000)) {
    return back(c, "/signup", { error: "Too many sign-ups from this network. Try again later.", next });
  }
  if (!email) return back(c, "/signup", { error: "Enter a valid email address.", email: f.email, next });
  const problem = passwordProblem(f.password ?? "");
  if (problem) return back(c, "/signup", { error: problem, email, next });
  if (await findUserByEmail(email)) {
    return back(c, "/login", { error: "You already have an account. Log in instead.", email, next });
  }

  const user = await createUser({
    email,
    name: f.name?.trim().slice(0, 100) || null,
    passwordHash: await hashPassword(f.password),
  });
  setSessionCookie(c, await createSession(user.id, "web"));
  return c.redirect(webLink(next), 303);
});

auth.post("/login", async (c) => {
  const f = await form(c);
  const next = safeNext(f.next);
  const email = normalizeEmail(f.email ?? "") ?? "";
  const ip = clientIp(c.req.header("x-forwarded-for"));
  if (rateLimited(`login:${ip}`, 30, 15 * 60_000) || rateLimited(`login:${email}`, 10, 15 * 60_000)) {
    return back(c, "/login", { error: "Too many attempts. Wait a few minutes and try again.", email, next });
  }

  const user = email ? await findUserByEmail(email) : null;
  const ok = user?.passwordHash ? await verifyPassword(f.password ?? "", user.passwordHash) : false;
  if (!user || !ok) {
    return back(c, "/login", { error: "Incorrect email or password.", email, next });
  }
  setSessionCookie(c, await createSession(user.id, "web"));
  return c.redirect(webLink(next), 303);
});

auth.post("/logout", async (c) => {
  const token = sessionToken(c);
  if (token) await deleteSession(token);
  // Desktop app calls this with a header and expects JSON.
  if (c.req.header("x-interviewveil-session")) return c.json({ ok: true });
  clearSessionCookie(c);
  const f = await form(c).catch(() => ({}) as Record<string, string>);
  return c.redirect(webLink(f.next ? safeNext(f.next) : "/"), 303);
});

// ---- password reset -------------------------------------------------------------

auth.post("/forgot", async (c) => {
  const f = await form(c);
  const email = normalizeEmail(f.email ?? "");
  const done = () => back(c, "/forgot", { sent: "1" });
  if (!email || rateLimited(`forgot:${email}`, 3, 60 * 60_000)) return done();

  const user = await findUserByEmail(email);
  if (user) {
    const token = randomToken();
    await db.insert(passwordResets).values({
      tokenHash: sha256(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    await sendPasswordReset(email, webLink(`/reset?token=${token}`)).catch((e) =>
      console.error("password reset email failed", e),
    );
  }
  return done(); // same response either way: don't reveal which emails exist
});

auth.post("/reset", async (c) => {
  const f = await form(c);
  const token = f.token ?? "";
  const problem = passwordProblem(f.password ?? "");
  if (problem) return back(c, "/reset", { token, error: problem });

  const [reset] = await db
    .select()
    .from(passwordResets)
    .where(
      and(
        eq(passwordResets.tokenHash, sha256(token)),
        gt(passwordResets.expiresAt, new Date()),
        isNull(passwordResets.usedAt),
      ),
    );
  if (!reset) return back(c, "/forgot", { error: "That reset link is invalid or expired. Request a new one." });

  await db.transaction(async (tx) => {
    await tx.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.tokenHash, reset.tokenHash));
    // Receiving the email proves the address belongs to them.
    await tx
      .update(users)
      .set({ passwordHash: await hashPassword(f.password), emailVerified: true })
      .where(eq(users.id, reset.userId));
  });
  await deleteAllSessions(reset.userId); // sign out everywhere else
  setSessionCookie(c, await createSession(reset.userId, "web"));
  return c.redirect(webLink("/dashboard?notice=password-updated"), 303);
});

// ---- Google / GitHub --------------------------------------------------------------

auth.get("/:provider", (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider)) return c.notFound();
  if (!providerEnabled(provider)) {
    return back(c, "/login", { error: `${provider === "google" ? "Google" : "GitHub"} sign-in isn't set up yet.` });
  }
  return startOAuth(c, provider, c.req.query("next") ?? "/dashboard");
});

auth.get("/:provider/callback", async (c) => {
  const provider = c.req.param("provider");
  if (!isProvider(provider)) return c.notFound();
  try {
    const { profile, next } = await finishOAuth(c, provider);
    const user = await upsertOAuthUser(profile);
    setSessionCookie(c, await createSession(user.id, "web"));
    return c.redirect(webLink(next), 303);
  } catch (e) {
    console.error(`oauth ${provider} failed`, e);
    return back(c, "/login", { error: e instanceof Error ? e.message : "Sign-in failed." });
  }
});

// ---- desktop app sign-in (approve in the browser, app polls) --------------------

const DESKTOP_LOGIN_TTL_MS = 10 * 60_000;
/** No 0/O/1/I so it's easy to compare by eye. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** e.g. "K7QM-3XRP": shown in both the app and the browser so the user can match them. */
function pairingCode(): string {
  const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

auth.post("/desktop/start", async (c) => {
  if (rateLimited(`desktop:${clientIp(c.req.header("x-forwarded-for"))}`, 20, 15 * 60_000)) {
    return c.json({ error: "Too many sign-in attempts. Try again shortly." }, 429);
  }
  await db.delete(desktopLogins).where(lt(desktopLogins.expiresAt, new Date()));
  const id = randomToken(18);
  const secret = randomToken();
  const userCode = pairingCode();
  const expiresAt = new Date(Date.now() + DESKTOP_LOGIN_TTL_MS);
  await db.insert(desktopLogins).values({ id, secretHash: sha256(secret), userCode, expiresAt });
  return c.json({ id, secret, userCode, url: webLink(`/desktop/connect?id=${id}`), expiresAt });
});

auth.post("/desktop/poll", async (c) => {
  const { id, secret } = (await c.req.json().catch(() => ({}))) as { id?: string; secret?: string };
  const [login] = id ? await db.select().from(desktopLogins).where(eq(desktopLogins.id, id)) : [];
  if (!login || login.secretHash !== sha256(secret ?? "")) return c.json({ status: "invalid" }, 404);
  if (login.expiresAt < new Date()) {
    await db.delete(desktopLogins).where(eq(desktopLogins.id, login.id));
    return c.json({ status: "expired" }, 410);
  }
  if (!login.userId) return c.json({ status: "pending" }, 202);

  // Approved: hand out one desktop session, exactly once.
  const [claimed] = await db.delete(desktopLogins).where(eq(desktopLogins.id, login.id)).returning();
  if (!claimed?.userId) return c.json({ status: "invalid" }, 404);
  const token = await createSession(claimed.userId, "desktop");
  return c.json({ status: "approved", token, account: await accountSummary(claimed.userId) });
});

/** Website: details of a pending desktop sign-in, so the user can match the code. */
auth.get("/desktop/request", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ type: "error", error: { type: "unauthorized", message: "Please sign in." } }, 401);
  const [pending] = await db
    .select({ userCode: desktopLogins.userCode, expiresAt: desktopLogins.expiresAt })
    .from(desktopLogins)
    .where(
      and(
        eq(desktopLogins.id, c.req.query("id") ?? ""),
        isNull(desktopLogins.userId),
        gt(desktopLogins.expiresAt, new Date()),
      ),
    );
  if (!pending) return c.json({ type: "error", error: { type: "expired", message: "This sign-in request has expired." } }, 404);
  return c.json({ userCode: pending.userCode, expiresAt: pending.expiresAt, email: user.email });
});

/** Website: the signed-in user approves a pending desktop sign-in. */
auth.post("/desktop/approve", async (c) => {
  const user = await currentUser(c);
  const f = await form(c);
  if (!user) return back(c, "/login", { next: `/desktop/connect?id=${f.id ?? ""}` });
  const [updated] = await db
    .update(desktopLogins)
    .set({ userId: user.id })
    .where(and(eq(desktopLogins.id, f.id ?? ""), isNull(desktopLogins.userId), gt(desktopLogins.expiresAt, new Date())))
    .returning();
  return back(c, "/desktop/connect", { id: f.id ?? "", ...(updated ? { approved: "1" } : { error: "This sign-in request expired. Start again from the app." }) });
});
