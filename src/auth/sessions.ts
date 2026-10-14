import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { sessions, users, type User } from "../db/schema.js";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "interviewveil_session";

export async function createSession(userId: string, kind: "web" | "desktop"): Promise<string> {
  const token = randomToken();
  await db.insert(sessions).values({
    id: sha256(token),
    userId,
    kind,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  // Opportunistic cleanup of expired sessions.
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  return token;
}

export async function userForSession(token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())));
  return row?.user ?? null;
}

export async function deleteSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sha256(token)));
}

export async function deleteAllSessions(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** Desktop app: `x-interviewveil-session` header. Web portal: HttpOnly cookie. */
export function sessionToken(c: Context): string | undefined {
  const header = c.req.header("x-interviewveil-session");
  if (header) return header;
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return getCookie(c, SESSION_COOKIE);
}

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.production,
    sameSite: "Lax",
    path: "/",
    domain: config.cookieDomain,
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: "/", domain: config.cookieDomain });
}

export async function currentUser(c: Context): Promise<User | null> {
  return userForSession(sessionToken(c));
}
