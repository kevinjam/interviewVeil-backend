/** All server configuration comes from environment variables. */

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const publicUrl = (process.env.PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, "");
const webUrl = (process.env.WEB_URL ?? "http://localhost:5173").replace(/\/$/, "");

export const config = {
  port: num("PORT", 8787),
  logLevel: oneOf(process.env.LOG_LEVEL?.toLowerCase(), ["debug", "info", "warn", "error"] as const, "info"),
  /** pretty in local, json in production unless LOG_FORMAT overrides. */
  logFormat: oneOf(
    process.env.LOG_FORMAT?.toLowerCase() || (process.env.NODE_ENV === "production" ? "json" : "pretty"),
    ["pretty", "json"] as const,
    "pretty",
  ),
  /** Public base URL of this API (OAuth callbacks, Stripe webhooks). e.g. https://api.interviewveil.app */
  publicUrl,
  /** The website (landing, login, dashboard). Users are redirected here. e.g. https://interviewveil.app */
  webUrl,
  /**
   * Cookie domain shared by the website and API, e.g. ".interviewveil.app" when the
   * site is interviewveil.app and the API is api.interviewveil.app. Unset in local dev.
   */
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  production: process.env.NODE_ENV === "production",
  databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/interviewveil",

  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  /** Required for unscoped user keys (`sk-ant-usr-…`). Workspace keys do not need this. */
  anthropicWorkspaceId: process.env.ANTHROPIC_WORKSPACE_ID ?? "",
  /**
   * Model per tier. Plans map to tiers in `plans.ts`; override here when
   * Anthropic ships new model versions. Chat upstream is `AI_PROVIDER`
   * (`anthropic` default, or `openrouter` + `MODEL_OPENROUTER` for testing).
   */
  models: {
    haiku: process.env.MODEL_HAIKU ?? "claude-haiku-4-5",
    sonnet: process.env.MODEL_SONNET ?? "claude-sonnet-5-5",
    opus: process.env.MODEL_OPUS ?? "claude-opus-5-5",
    /** Screenshots + live listen (explain / follow_up). Defaults to Sonnet. */
    explain: process.env.MODEL_EXPLAIN ?? process.env.MODEL_SONNET ?? "claude-sonnet-5-5",
  },

  /** OpenAI-compatible transcription upstream. */
  sttBaseUrl: (process.env.STT_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
  sttKey: process.env.STT_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
  sttModel: process.env.STT_MODEL ?? "gpt-4o-mini-transcribe",

  /** Email delivery via Brevo (password resets). Unset → links are logged (dev only). */
  brevoKey: process.env.BREVO_API_KEY ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "InterviewVeil <hello@interviewveil.app>",
  /** Users who can answer support chats (verified email required). Comma-separated. */
  adminEmails: (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  /** Support hours shown in the chat widget, e.g. "Mon-Fri 09:00-18:00". */
  supportHours: process.env.SUPPORT_HOURS ?? "Mon-Fri 09:00-18:00",
  /** IANA time zone for SUPPORT_HOURS, e.g. "Africa/Nairobi". */
  supportTimezone: process.env.SUPPORT_TIMEZONE ?? "UTC",

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  },
  github: {
    clientId: process.env.GITHUB_CLIENT_ID ?? "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
  },

  stripeSecret: process.env.STRIPE_SECRET_KEY ?? "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  /** Days on a paid plan before the first charge (first subscription only). Set 0 to disable. */
  billingTrialDays: num("BILLING_TRIAL_DAYS", 3),

  difficulty: oneOf(process.env.PRACTICE_DIFFICULTY, ["easy", "medium", "hard"] as const, "medium"),
  /** Per-user AI requests per minute (fair use, all plans). */
  rateLimitPerMinute: num("RATE_LIMIT_PER_MINUTE", 20),
};

export const MAX_OUTPUT_TOKENS = 16000;
/** explain / follow_up — discourages essay-length answers while leaving room for code. */
export const MAX_OUTPUT_TOKENS_LIVE_ASSIST = num("MAX_OUTPUT_TOKENS_LIVE_ASSIST", 8192);

/** Absolute URL on the website for a same-site path like "/dashboard?x=1". */
export function webLink(path: string): string {
  return `${config.webUrl}${path.startsWith("/") ? path : `/${path}`}`;
}
