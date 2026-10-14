import "./env.js";
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { parseHours, withinHours } from "../src/chat/hours.js";
import { db } from "../src/db/client.js";
import { chatConversations, users } from "../src/db/schema.js";
import { app } from "../src/index.js";
import { closeDb, resetDb } from "./setup.js";

beforeEach(resetDb);
after(closeDb);

const WEB = "http://localhost:5173";
let ip = 0;
const json = (method: string, path: string, body?: object, headers: Record<string, string> = {}) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", origin: WEB, "x-forwarded-for": `10.8.${Math.floor(++ip / 250)}.${ip % 250}`, ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

async function signup(email: string, verified = false) {
  const res = await app.request("/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: WEB, "x-forwarded-for": `10.7.0.${++ip % 250}` },
    body: new URLSearchParams({ email, password: "correct horse" }).toString(),
  });
  if (verified) await db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function startChat(message = "Do you have student discounts?") {
  const res = await json("POST", "/chat/conversations", { name: "Ada", email: "ada@example.com", message, page: "/pricing" });
  assert.equal(res.status, 200);
  return (await res.json()) as { token: string; conversation: { id: string }; messages: { id: number }[] };
}

describe("support chat", () => {
  it("full round trip: visitor asks, admin replies, visitor receives it live", async () => {
    const admin = await signup("admin@interviewveil.test", true);
    const { token, conversation, messages } = await startChat();
    assert.equal(messages.length, 1);

    // Admin inbox shows it unread.
    const list = await (await json("GET", "/admin/chat/conversations", undefined, { cookie: admin })).json();
    assert.equal(list.unreadTotal, 1);
    assert.equal(list.conversations[0].preview, "Do you have student discounts?");

    // Opening it marks it read.
    const thread = await (await json("GET", `/admin/chat/conversations/${conversation.id}`, undefined, { cookie: admin })).json();
    assert.equal(thread.conversation.page, "/pricing");
    const after = await (await json("GET", "/admin/chat/conversations", undefined, { cookie: admin })).json();
    assert.equal(after.unreadTotal, 0);

    // Visitor is long-polling when the admin replies.
    const started = Date.now();
    const poll = json("GET", `/chat/messages?after=${messages[0].id}&wait=1`, undefined, { "x-chat-token": token });
    await new Promise((r) => setTimeout(r, 150));
    await json("POST", `/admin/chat/conversations/${conversation.id}/messages`, { body: "Yes — 30% off with a .edu email!" }, { cookie: admin });
    const got = await (await poll).json();
    assert.ok(Date.now() - started < 3000, "long-poll returned promptly");
    assert.equal(got.messages.length, 1);
    assert.equal(got.messages[0].sender, "admin");
    assert.equal(got.conversation.unread, 1);

    // Visitor reads, then replies.
    await json("POST", "/chat/read", {}, { "x-chat-token": token });
    const reply = await json("POST", "/chat/messages", { body: "Great, thanks!" }, { "x-chat-token": token });
    assert.equal(reply.status, 200);
    const resumed = await (await json("GET", "/chat/conversation", undefined, { "x-chat-token": token })).json();
    assert.deepEqual(resumed.messages.map((m: { sender: string }) => m.sender), ["visitor", "admin", "visitor"]);
    assert.equal(resumed.conversation.unread, 0);
  });

  it("closing a conversation, and a visitor message reopening it", async () => {
    const admin = await signup("admin@interviewveil.test", true);
    const { token, conversation } = await startChat();
    await json("POST", `/admin/chat/conversations/${conversation.id}/status`, { status: "closed" }, { cookie: admin });
    let [row] = await db.select().from(chatConversations);
    assert.equal(row.status, "closed");
    await json("POST", "/chat/messages", { body: "One more thing" }, { "x-chat-token": token });
    [row] = await db.select().from(chatConversations);
    assert.equal(row.status, "open");
  });

  it("links chats from signed-in users to their account", async () => {
    const cookie = await signup("grace@example.com");
    await json("POST", "/chat/conversations", { email: "grace@example.com", message: "Billing question" }, { cookie });
    const [row] = await db.select().from(chatConversations);
    assert.ok(row.userId);
  });

  it("keeps the inbox to verified admins", async () => {
    assert.equal((await json("GET", "/admin/chat/conversations")).status, 401);
    const regular = await signup("grace@example.com", true);
    assert.equal((await json("GET", "/admin/chat/conversations", undefined, { cookie: regular })).status, 403);
    // Someone registering the admin address without proving it gets nothing.
    const squatter = await signup("admin@interviewveil.test", false);
    assert.equal((await json("GET", "/admin/chat/conversations", undefined, { cookie: squatter })).status, 403);
    const acct = await (await json("GET", "/account", undefined, { cookie: squatter })).json();
    assert.equal(acct.isAdmin, false);
  });

  it("rejects unknown tokens, bad input and bots", async () => {
    assert.equal((await json("GET", "/chat/conversation", undefined, { "x-chat-token": "guess" })).status, 404);
    assert.equal((await json("POST", "/chat/conversations", { email: "nope", message: "hello" })).status, 400);
    assert.equal((await json("POST", "/chat/conversations", { email: "a@b.co", message: "x".repeat(4001) })).status, 400);
    const bot = await json("POST", "/chat/conversations", { email: "bot@spam.example", message: "buy", website: "x" });
    assert.equal(bot.status, 200);
    assert.equal((await db.select().from(chatConversations)).length, 0);
  });

  it("limits how many chats one address can start", async () => {
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await json("POST", "/chat/conversations", { email: "flood@example.com", message: `hi ${i}` })).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
  });

  it("reports status from working hours and admin presence", async () => {
    const res = await (await json("GET", "/chat/status")).json();
    assert.ok(["online", "away", "offline"].includes(res.status));
  });
});

describe("support hours", () => {
  const h = parseHours("Mon-Fri 09:00-18:00")!;
  it("parses day ranges and times", () => {
    assert.deepEqual([...h.days].sort(), [1, 2, 3, 4, 5]);
    assert.deepEqual([h.startMin, h.endMin], [540, 1080]);
    assert.deepEqual([...parseHours("Fri-Mon 10:00-12:00")!.days].sort(), [0, 1, 5, 6]);
    assert.equal(parseHours("whenever"), null);
  });
  it("evaluates in the support time zone", () => {
    // Wed 2026-10-14 06:30 UTC = 09:30 in Nairobi (UTC+3): open there, closed in UTC.
    const t = new Date("2026-10-14T06:30:00Z");
    assert.equal(withinHours(h, "Africa/Nairobi", t), true);
    assert.equal(withinHours(h, "UTC", t), false);
    // Saturday is closed.
    assert.equal(withinHours(h, "Africa/Nairobi", new Date("2026-10-17T08:00:00Z")), false);
  });
});

describe("typing indicators", () => {
  it("visitor sees the team typing live; sending a message clears it", async () => {
    const admin = await signup("admin@interviewveil.test", true);
    const { token, conversation, messages } = await startChat();
    const last = messages[0].id;

    // Visitor is waiting when the admin starts typing: the poll wakes with no new messages.
    const started = Date.now();
    const poll = json("GET", `/chat/messages?after=${last}&wait=1`, undefined, { "x-chat-token": token });
    await new Promise((r) => setTimeout(r, 100));
    await json("POST", `/admin/chat/conversations/${conversation.id}/typing`, { typing: true }, { cookie: admin });
    const woke = await (await poll).json();
    assert.ok(Date.now() - started < 3000, "long-poll woke promptly");
    assert.equal(woke.messages.length, 0);
    assert.ok(woke.adminTypingUntil > Date.now(), "team shown as typing");

    // The reply itself ends "typing".
    await json("POST", `/admin/chat/conversations/${conversation.id}/messages`, { body: "Hello!" }, { cookie: admin });
    const after = await (await json("GET", `/chat/messages?after=${last}`, undefined, { "x-chat-token": token })).json();
    assert.equal(after.messages.length, 1);
    assert.equal(after.adminTypingUntil, null);
  });

  it("admin sees the visitor typing in the thread and the list", async () => {
    const admin = await signup("admin@interviewveil.test", true);
    const { token, conversation } = await startChat();
    await json("POST", "/chat/typing", { typing: true }, { "x-chat-token": token });

    const thread = await (await json("GET", `/admin/chat/conversations/${conversation.id}`, undefined, { cookie: admin })).json();
    assert.ok(thread.visitorTypingUntil > Date.now());
    const list = await (await json("GET", "/admin/chat/conversations", undefined, { cookie: admin })).json();
    assert.equal(list.conversations[0].visitorTyping, true);

    await json("POST", "/chat/typing", { typing: false }, { "x-chat-token": token });
    const cleared = await (await json("GET", `/admin/chat/conversations/${conversation.id}`, undefined, { cookie: admin })).json();
    assert.equal(cleared.visitorTypingUntil, null);
  });

  it("expires on its own if the typist disappears", async () => {
    const { setTyping, typingUntil, TYPING_TTL_MS } = await import("../src/chat/typing.js");
    const t0 = 1_000_000;
    setTyping("c1", "visitor", true, t0);
    assert.equal(typingUntil("c1", "visitor", t0 + 1000), t0 + TYPING_TTL_MS);
    assert.equal(typingUntil("c1", "visitor", t0 + TYPING_TTL_MS + 1), null);
  });

  it("requires a valid conversation token", async () => {
    assert.equal((await json("POST", "/chat/typing", { typing: true }, { "x-chat-token": "nope" })).status, 404);
  });
});
