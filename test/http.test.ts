import "./env.js";
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { audioBalances, tokenBalances, usageHistory, users } from "../src/db/schema.js";
import { PLANS } from "../src/plans.js";
import { app } from "../src/index.js";
import { closeDb, resetDb } from "./setup.js";

beforeEach(resetDb);
after(closeDb);

const ORIGIN = "http://localhost:5173"; // the website posts the forms
const WEB = "http://localhost:5173";
/** Each request looks like a different client so per-IP rate limits don't trip across tests. */
let ipCounter = 0;
const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

function formPost(path: string, fields: Record<string, string>, cookie?: string, origin = ORIGIN) {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      "x-forwarded-for": freshIp(),
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

const sessionCookie = (res: Response) =>
  (res.headers.get("set-cookie") ?? "").split(";")[0];

async function signup(email = "grace@example.com", password = "correct horse") {
  const res = await formPost("/auth/signup", { email, password, name: "Grace Hopper", next: "/dashboard" });
  assert.equal(res.status, 303);
  return sessionCookie(res);
}

describe("email + password auth", () => {
  it("signs up, then reads the account with the session cookie", async () => {
    const cookie = await signup();
    const res = await app.request("/account", { headers: { cookie } });
    assert.equal(res.status, 200);
    const acct = await res.json();
    assert.equal(acct.email, "grace@example.com");
    assert.equal(acct.plan, "free");
    assert.equal(acct.tokensLeft, 3);
    assert.equal(acct.audioSecondsLeft, PLANS.free.audioSecondsPerMonth);
    assert.equal(acct.model, undefined);
  });

  it("rejects duplicate signups and wrong passwords", async () => {
    await signup();
    const dup = await formPost("/auth/signup", { email: "GRACE@example.com", password: "another pass" });
    assert.match(dup.headers.get("location") ?? "", /^http:\/\/localhost:5173\/login\?error=/);
    const bad = await formPost("/auth/login", { email: "grace@example.com", password: "wrong password" });
    const params = new URL(bad.headers.get("location") ?? "", ORIGIN).searchParams;
    assert.equal(params.get("error"), "Incorrect email or password.");
    const good = await formPost("/auth/login", { email: "grace@example.com", password: "correct horse" });
    assert.equal(good.headers.get("location"), `${WEB}/dashboard`);
  });

  it("stores only a password hash", async () => {
    await signup();
    const [u] = await db.select().from(users);
    assert.ok(u.passwordHash?.startsWith("scrypt$"));
    assert.ok(!u.passwordHash?.includes("correct horse"));
  });

  it("blocks cross-site form posts made with a session cookie", async () => {
    const cookie = await signup();
    const res = await formPost("/billing/cancel", {}, cookie, "https://evil.example");
    assert.equal(res.status, 403);
  });

  it("only redirects to same-site paths after login", async () => {
    const res = await formPost("/auth/signup", {
      email: "x@example.com",
      password: "long enough",
      next: "//evil.example/steal",
    });
    assert.equal(res.headers.get("location"), `${WEB}/dashboard`);
  });
});

describe("desktop sign-in handoff", () => {
  it("app polls, user approves in the browser, app gets a session once", async () => {
    const cookie = await signup();
    const start = await (await app.request("/auth/desktop/start", { method: "POST", headers: { "x-forwarded-for": freshIp() } })).json();
    assert.match(start.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const poll = () =>
      app.request("/auth/desktop/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: start.id, secret: start.secret }),
      });
    assert.equal((await poll()).status, 202);

    assert.match(start.url, new RegExp(`^${WEB}/desktop/connect\\?id=`));
    const pending = await app.request(`/auth/desktop/request?id=${start.id}`, { headers: { cookie } });
    assert.equal((await pending.json()).userCode, start.userCode);
    await formPost("/auth/desktop/approve", { id: start.id }, cookie);

    const approved = await poll();
    assert.equal(approved.status, 200);
    const body = await approved.json();
    assert.equal(body.account.email, "grace@example.com");
    assert.equal((await poll()).status, 404, "a handoff can only be claimed once");

    const acct = await app.request("/account", { headers: { "x-interviewveil-session": body.token } });
    assert.equal(acct.status, 200);
  });

  it("rejects a poll with the wrong secret", async () => {
    const start = await (await app.request("/auth/desktop/start", { method: "POST", headers: { "x-forwarded-for": freshIp() } })).json();
    const res = await app.request("/auth/desktop/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: start.id, secret: "guess" }),
    });
    assert.equal(res.status, 404);
  });
});

describe("AI proxy", () => {
  const realFetch = globalThis.fetch;
  let lastBody: Record<string, unknown> | null = null;
  let lastHeaders: Headers | null = null;

  function mockAnthropic(sse: string, status = 200) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://api.anthropic.com/")) return realFetch(input, init);
      lastBody = JSON.parse(String(init?.body));
      lastHeaders = new Headers(init?.headers);
      return new Response(sse, {
        status,
        headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" },
      });
    }) as typeof fetch;
  }
  after(() => {
    globalThis.fetch = realFetch;
  });

  const ev = (type: string, extra: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
  const fullStream =
    ev("message_start", { message: { usage: { input_tokens: 50 } } }) +
    ev("content_block_delta", { delta: { type: "text_delta", text: "## Question\nHi" } }) +
    ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }) +
    ev("message_stop");

  async function desktopToken() {
    const cookie = await signup();
    const start = await (await app.request("/auth/desktop/start", { method: "POST", headers: { "x-forwarded-for": freshIp() } })).json();
    await formPost("/auth/desktop/approve", { id: start.id }, cookie);
    const res = await app.request("/auth/desktop/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: start.id, secret: start.secret }),
    });
    return (await res.json()).token as string;
  }

  const ask = (token: string, model = "claude-opus-5-5") =>
    app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-interviewveil-session": token,
        "x-interviewveil-kind": "question",
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 999999,
        stream: true,
        output_config: { effort: "low" },
        fallbacks: "default",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

  it("routes to the plan's model and charges one token after success", async () => {
    mockAnthropic(fullStream);
    const token = await desktopToken();
    const res = await ask(token, "claude-opus-5-5"); // asks for Opus on the Free plan
    assert.equal(res.status, 200);
    assert.match(await res.text(), /message_stop/);

    assert.equal(lastBody?.model, "claude-haiku-4-5", "free plan can't reach Opus");
    assert.equal(lastBody?.max_tokens, 16000);
    assert.equal(lastBody?.output_config, undefined, "haiku 4.5 params stripped");
    assert.equal(lastHeaders?.get("anthropic-workspace-id"), "wrkspc_test");

    const [bal] = await db.select().from(tokenBalances);
    assert.equal(bal.balance, 2);
    const [usage] = await db.select().from(usageHistory);
    assert.deepEqual(
      [usage.model, usage.kind, usage.inputTokens, usage.outputTokens, usage.tokensSpent],
      ["claude-haiku-4-5", "question", 50, 7, 1],
    );
  });

  it("routes Expert to Opus", async () => {
    mockAnthropic(fullStream);
    const token = await desktopToken();
    await db.update(users).set({ plan: "expert" });
    await ask(token, "claude-haiku-4-5").then((r) => r.text());
    assert.equal(lastBody?.model, "claude-opus-5-5");
  });

  it("routes explain to sonnet and replaces system prompt from headers", async () => {
    mockAnthropic(fullStream);
    const token = await desktopToken();
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-interviewveil-session": token,
        "x-interviewveil-kind": "explain",
        "x-interviewveil-mode": "coding",
        "x-interviewveil-language": "python",
        "x-interviewveil-answer-language": "English",
        "x-interviewveil-custom-prompt": "Prefer BFS when asked.",
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 16000,
        stream: true,
        system: "client prompt must be ignored",
        messages: [{ role: "user", content: [{ type: "text", text: "solve from screenshot" }] }],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(lastBody?.model, "claude-sonnet-5-5", "MODEL_EXPLAIN for explain on free");
    assert.equal(lastBody?.max_tokens, 8192, "live assist capped");
    const system = String(lastBody?.system ?? "");
    assert.match(system, /InterviewVeil/);
    assert.match(system, /Thoughts \(Say to interviewer\)|## Code/);
    assert.match(system, /BFS when asked/);
    assert.doesNotMatch(system, /client prompt must be ignored/);
  });

  it("strips low effort on explain even when client sends it", async () => {
    mockAnthropic(fullStream);
    const token = await desktopToken();
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-interviewveil-session": token,
        "x-interviewveil-kind": "explain",
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        max_tokens: 16000,
        stream: true,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(lastBody?.output_config, undefined);
  });

  it("refunds when the stream is cut off or refused", async () => {
    const token = await desktopToken();
    mockAnthropic(ev("message_start") + ev("content_block_delta"));
    await (await ask(token)).text();
    mockAnthropic(ev("message_delta", { delta: { stop_reason: "refusal" } }) + ev("message_stop"));
    await (await ask(token)).text();
    const [bal] = await db.select().from(tokenBalances);
    assert.equal(bal.balance, 3);
    assert.equal((await db.select().from(usageHistory)).length, 0);
  });

  it("refunds on upstream errors", async () => {
    mockAnthropic(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }), 529);
    const token = await desktopToken();
    const res = await ask(token);
    assert.equal(res.status, 529);
    const [bal] = await db.select().from(tokenBalances);
    assert.equal(bal.balance, 3);
  });

  it("blocks requests at zero tokens with a clear error", async () => {
    mockAnthropic(fullStream);
    const token = await desktopToken();
    await db.update(tokenBalances).set({ balance: 0 });
    const res = await ask(token);
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error.type, "insufficient_tokens");
    assert.match(body.error.message, /out of tokens/);
  });

  it("requires a session", async () => {
    const res = await app.request("/v1/messages", { method: "POST", body: "{}" });
    assert.equal(res.status, 401);
  });

  it("forwards to OpenRouter when AI_PROVIDER=openrouter", async () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.MODEL_OPENROUTER = "cohere/north-mini-code:free";
    let lastUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      lastUrl = String(input instanceof Request ? input.url : input);
      lastBody = JSON.parse(String(init?.body));
      lastHeaders = new Headers(init?.headers);
      return new Response(fullStream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const token = await desktopToken();
      const res = await ask(token, "claude-opus-5-5");
      assert.equal(res.status, 200);
      assert.equal(lastUrl, "https://openrouter.ai/api/v1/messages");
      assert.equal(lastBody?.model, "cohere/north-mini-code:free");
      assert.equal(lastHeaders?.get("authorization"), "Bearer sk-or-test");
      assert.equal(lastHeaders?.get("anthropic-workspace-id"), null);
    } finally {
      delete process.env.AI_PROVIDER;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.MODEL_OPENROUTER;
    }
  });

  it("unwraps OpenRouter Provider returned error for the client", async () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.MODEL_OPENROUTER = "cohere/north-mini-code:free";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Provider returned error",
            code: 400,
            metadata: {
              raw: JSON.stringify({ message: "prompt is too long" }),
              provider_name: "Cohere",
            },
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const token = await desktopToken();
      const res = await ask(token);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(
        body.error.message,
        "That was too much to send at once. Use fewer screenshots or a shorter question.",
      );
      assert.match(res.headers.get("x-request-id") ?? "", /^[\w.-]{8,}$/);
    } finally {
      delete process.env.AI_PROVIDER;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.MODEL_OPENROUTER;
    }
  });
});

describe("transcription proxy", () => {
  const realFetch = globalThis.fetch;

  function mockStt(text = "hello world") {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/audio/transcriptions")) {
        return new Response(JSON.stringify({ text }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    }) as typeof fetch;
  }

  after(() => {
    globalThis.fetch = realFetch;
  });

  async function desktopToken() {
    const cookie = await signup("stt@example.com");
    const start = await (await app.request("/auth/desktop/start", { method: "POST", headers: { "x-forwarded-for": freshIp() } })).json();
    await formPost("/auth/desktop/approve", { id: start.id }, cookie);
    const res = await app.request("/auth/desktop/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: start.id, secret: start.secret }),
    });
    return (await res.json()).token as string;
  }

  /** Minimal payload; duration falls back to byte size at 16 kHz mono. */
  const oneSecondWav = new Uint8Array(32_000);

  it("deducts listening seconds and does not require AI tokens", async () => {
    mockStt();
    const token = await desktopToken();
    await db.update(tokenBalances).set({ balance: 0 });

    const form = new FormData();
    form.append("file", new Blob([oneSecondWav], { type: "audio/wav" }), "segment.wav");
    const res = await app.request("/v1/audio/transcriptions", {
      method: "POST",
      headers: { "x-interviewveil-session": token },
      body: form,
    });
    assert.equal(res.status, 200);
    const [bal] = await db.select().from(audioBalances);
    assert.equal(bal.balance, PLANS.free.audioSecondsPerMonth - 1);
    const [tokens] = await db.select().from(tokenBalances);
    assert.equal(tokens.balance, 0);
  });

  it("blocks when listening seconds are exhausted", async () => {
    mockStt();
    const token = await desktopToken();
    await db.update(audioBalances).set({ balance: 0 });

    const form = new FormData();
    form.append("file", new Blob([oneSecondWav], { type: "audio/wav" }), "segment.wav");
    const res = await app.request("/v1/audio/transcriptions", {
      method: "POST",
      headers: { "x-interviewveil-session": token },
      body: form,
    });
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error.type, "insufficient_audio_seconds");
  });
});

describe("website integration", () => {
  it("lets the website call the API with cookies, and nobody else", async () => {
    const trusted = await app.request("/account", { method: "OPTIONS", headers: { origin: WEB } });
    assert.equal(trusted.headers.get("access-control-allow-origin"), WEB);
    assert.equal(trusted.headers.get("access-control-allow-credentials"), "true");

    const other = await app.request("/account", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    assert.equal(other.headers.get("access-control-allow-origin"), "*");
    assert.equal(other.headers.get("access-control-allow-credentials"), null);
  });

  it("serves the public plan catalog", async () => {
    const plans = await (await app.request("/billing/plans")).json();
    assert.deepEqual(
      plans.map((p: { id: string; price: string }) => `${p.id}:${p.price}`),
      ["free:$0", "essential:$13", "professional:$24", "expert:$44"],
    );
  });

  it("sends visitors of the API root to the website", async () => {
    const res = await app.request("/");
    assert.equal(res.headers.get("location"), WEB);
  });

  it("returns 401 JSON for the dashboard data when signed out", async () => {
    const res = await app.request("/account", { headers: { origin: WEB } });
    assert.equal(res.status, 401);
  });

  it("assigns a request id on every response", async () => {
    const res = await app.request("/health");
    assert.match(res.headers.get("x-request-id") ?? "", /^[\w.-]{8,}$/);
  });
});
