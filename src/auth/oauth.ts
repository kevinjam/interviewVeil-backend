import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "../config.js";
import type { OAuthProfile } from "./users.js";
import { randomToken } from "./sessions.js";

export type Provider = "google" | "github";

interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  fetchProfile: (accessToken: string) => Promise<OAuthProfile>;
}

async function getJson<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": "InterviewVeil" },
  });
  if (!res.ok) throw new Error(`profile request failed (${res.status})`);
  return (await res.json()) as T;
}

const PROVIDERS: Record<Provider, ProviderConfig> = {
  google: {
    ...config.google,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    async fetchProfile(token) {
      const p = await getJson<{ sub: string; email: string; email_verified: boolean; name?: string }>(
        "https://openidconnect.googleapis.com/v1/userinfo",
        token,
      );
      return {
        provider: "google",
        providerUserId: p.sub,
        email: p.email.toLowerCase(),
        emailVerified: Boolean(p.email_verified),
        name: p.name ?? null,
      };
    },
  },
  github: {
    ...config.github,
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
    async fetchProfile(token) {
      const user = await getJson<{ id: number; name: string | null; login: string }>(
        "https://api.github.com/user",
        token,
      );
      const emails = await getJson<{ email: string; primary: boolean; verified: boolean }[]>(
        "https://api.github.com/user/emails",
        token,
      );
      const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
      if (!primary) throw new Error("Your GitHub account has no verified email address.");
      return {
        provider: "github",
        providerUserId: String(user.id),
        email: primary.email.toLowerCase(),
        emailVerified: true,
        name: user.name ?? user.login,
      };
    },
  },
};

export function isProvider(p: string): p is Provider {
  return p === "google" || p === "github";
}

export function providerEnabled(p: Provider): boolean {
  return Boolean(PROVIDERS[p].clientId && PROVIDERS[p].clientSecret);
}

const STATE_COOKIE = "interviewveil_oauth";
const callbackUrl = (p: Provider) => `${config.publicUrl}/auth/${p}/callback`;

/** Only same-site relative paths may be used as post-login redirects. */
export function safeNext(next: string | undefined | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
}

/** Redirect the browser to the provider's consent screen. */
export function startOAuth(c: Context, provider: Provider, next: string) {
  const p = PROVIDERS[provider];
  const state = randomToken(24);
  setCookie(c, STATE_COOKIE, `${state}|${provider}|${safeNext(next)}`, {
    httpOnly: true,
    secure: config.production,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  const url = new URL(p.authorizeUrl);
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", callbackUrl(provider));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", p.scope);
  url.searchParams.set("state", state);
  if (provider === "google") url.searchParams.set("prompt", "select_account");
  return c.redirect(url.toString());
}

/** Validate state, exchange the code and load the provider profile. */
export async function finishOAuth(
  c: Context,
  provider: Provider,
): Promise<{ profile: OAuthProfile; next: string }> {
  const [state, cookieProvider, next] = (getCookie(c, STATE_COOKIE) ?? "").split("|");
  deleteCookie(c, STATE_COOKIE, { path: "/" });
  const code = c.req.query("code");
  if (!state || state !== c.req.query("state") || cookieProvider !== provider || !code) {
    throw new Error("Sign-in expired or was tampered with. Please try again.");
  }

  const p = PROVIDERS[provider];
  const res = await fetch(p.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code,
      redirect_uri: callbackUrl(provider),
      grant_type: "authorization_code",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description ?? "Couldn't complete sign-in with the provider.");
  }
  return { profile: await p.fetchProfile(body.access_token), next: safeNext(next) };
}
