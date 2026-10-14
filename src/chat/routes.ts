import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { currentUser, randomToken, sha256 } from "../auth/sessions.js";
import { normalizeEmail } from "../auth/users.js";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { chatConversations, chatMessages, subscriptions, users, type ChatConversation, type ChatMessage, type User } from "../db/schema.js";
import { clientIp, rateLimited } from "../rateLimit.js";
import {
  ADMIN_EVENT,
  adminRecentlySeen,
  conversationEvent,
  markAdminSeen,
  notify,
  notifyAdmins,
  notifyVisitor,
  waitFor,
} from "./bus.js";
import { setTyping, typingUntil } from "./typing.js";
import { parseHours, withinHours } from "./hours.js";

const MAX_BODY = 4000;
const LONG_POLL_MS = 25_000;

const err = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429, message: string) =>
  c.json({ error: message }, status);

const publicMessage = (m: ChatMessage) => ({ id: m.id, sender: m.sender, body: m.body, createdAt: m.createdAt });

const cleanBody = (v: unknown) => (typeof v === "string" ? v.trim() : "");

async function postMessage(conv: ChatConversation, sender: "visitor" | "admin", body: string, adminId?: string) {
  setTyping(conv.id, sender, false); // sending ends "is typing"
  const [msg] = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(chatMessages)
      .values({ conversationId: conv.id, sender, body, adminId: adminId ?? null })
      .returning();
    await tx
      .update(chatConversations)
      .set({
        lastMessageAt: new Date(),
        // A visitor writing again reopens a closed conversation.
        ...(sender === "visitor"
          ? { unreadByAdmin: sql`${chatConversations.unreadByAdmin} + 1`, status: "open" as const }
          : { unreadByVisitor: sql`${chatConversations.unreadByVisitor} + 1` }),
      })
      .where(eq(chatConversations.id, conv.id));
    return inserted;
  });
  notify(conv.id);
  return msg;
}

function messagesAfter(conversationId: string, afterId: number) {
  return db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.conversationId, conversationId), gt(chatMessages.id, afterId)))
    .orderBy(asc(chatMessages.id));
}

// ---- visitor ------------------------------------------------------------------------

export const chat = new Hono();

const hours = parseHours(config.supportHours);

/** Widget header: "online" (an admin has the inbox open), "away" (within hours), "offline". */
chat.get("/status", (c) => {
  const inHours = hours ? withinHours(hours, config.supportTimezone) : true;
  const status = adminRecentlySeen() ? "online" : inHours ? "away" : "offline";
  return c.json({ status, hours: config.supportHours, timezone: config.supportTimezone });
});

async function visitorConversation(c: Context): Promise<ChatConversation | null> {
  const token = c.req.header("x-chat-token");
  if (!token) return null;
  const [conv] = await db
    .select()
    .from(chatConversations)
    .where(eq(chatConversations.visitorTokenHash, sha256(token)));
  return conv ?? null;
}

const publicConversation = (conv: ChatConversation) => ({
  id: conv.id,
  status: conv.status,
  name: conv.name,
  email: conv.email,
  unread: conv.unreadByVisitor,
});

chat.post("/conversations", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (cleanBody(body.website)) return c.json({ ok: true }); // honeypot: bots fill hidden fields

  const email = normalizeEmail(cleanBody(body.email));
  const message = cleanBody(body.message);
  if (!email) return err(c, 400, "Enter a valid email so we can follow up.");
  if (message.length < 2) return err(c, 400, "Tell us how we can help.");
  if (message.length > MAX_BODY) return err(c, 400, `Keep it under ${MAX_BODY} characters.`);
  const ip = clientIp(c.req.header("x-forwarded-for"));
  if (rateLimited(`chat:start:${ip}`, 5, 60 * 60_000) || rateLimited(`chat:start:${email}`, 5, 60 * 60_000)) {
    return err(c, 429, "You've started a few chats already — we'll get back to you soon.");
  }

  const user = await currentUser(c);
  const token = randomToken();
  const [conv] = await db
    .insert(chatConversations)
    .values({
      visitorTokenHash: sha256(token),
      name: cleanBody(body.name).slice(0, 100) || user?.name || null,
      email,
      userId: user?.id ?? null,
      page: cleanBody(body.page).slice(0, 200) || null,
    })
    .returning();
  const msg = await postMessage(conv, "visitor", message);
  return c.json({ token, conversation: publicConversation({ ...conv, unreadByVisitor: 0 }), messages: [publicMessage(msg)] });
});

chat.get("/conversation", async (c) => {
  const conv = await visitorConversation(c);
  if (!conv) return err(c, 404, "Conversation not found.");
  const messages = await messagesAfter(conv.id, 0);
  return c.json({ conversation: publicConversation(conv), messages: messages.map(publicMessage) });
});

/** Long-poll: returns new messages as soon as they arrive (or [] after ~25s). */
chat.get("/messages", async (c) => {
  const conv = await visitorConversation(c);
  if (!conv) return err(c, 404, "Conversation not found.");
  const after = Number(c.req.query("after")) || 0;
  let messages = await messagesAfter(conv.id, after);
  if (messages.length === 0 && c.req.query("wait") === "1") {
    await waitFor(conversationEvent(conv.id), LONG_POLL_MS, c.req.raw.signal);
    messages = await messagesAfter(conv.id, after);
  }
  const [fresh] = await db.select().from(chatConversations).where(eq(chatConversations.id, conv.id));
  return c.json({
    conversation: publicConversation(fresh),
    messages: messages.map(publicMessage),
    /** Epoch ms until which the team counts as typing (null = not typing). */
    adminTypingUntil: typingUntil(conv.id, "admin"),
  });
});

/** Visitor typing indicator. Clients send true every ~3s while typing, false when they stop. */
chat.post("/typing", async (c) => {
  const conv = await visitorConversation(c);
  if (!conv) return err(c, 404, "Conversation not found.");
  if (rateLimited(`chat:typing:${conv.id}`, 60, 60_000)) return c.json({ ok: true });
  const isTyping = ((await c.req.json().catch(() => ({}))) as { typing?: unknown }).typing === true;
  // Changes always notify; refreshes do too, so the other side extends its expiry.
  if (setTyping(conv.id, "visitor", isTyping) || isTyping) notifyAdmins();
  return c.json({ ok: true });
});

chat.post("/messages", async (c) => {
  const conv = await visitorConversation(c);
  if (!conv) return err(c, 404, "Conversation not found.");
  const body = cleanBody(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).body);
  if (!body) return err(c, 400, "Write a message first.");
  if (body.length > MAX_BODY) return err(c, 400, `Keep it under ${MAX_BODY} characters.`);
  if (rateLimited(`chat:msg:${conv.id}`, 20, 60_000)) return err(c, 429, "Slow down a little — we're reading.");
  return c.json({ message: publicMessage(await postMessage(conv, "visitor", body)) });
});

/** The visitor has seen the admin's replies. */
chat.post("/read", async (c) => {
  const conv = await visitorConversation(c);
  if (!conv) return err(c, 404, "Conversation not found.");
  await db.update(chatConversations).set({ unreadByVisitor: 0 }).where(eq(chatConversations.id, conv.id));
  return c.json({ ok: true });
});

// ---- admin (support inbox) -------------------------------------------------------------

/** Admins: listed in ADMIN_EMAILS and the email has been proven (OAuth or reset link). */
export function isAdmin(user: Pick<User, "email" | "emailVerified"> | null): boolean {
  return Boolean(user && user.emailVerified && config.adminEmails.includes(user.email));
}

export const adminChat = new Hono<{ Variables: { admin: User } }>();

adminChat.use("*", async (c, next) => {
  const user = await currentUser(c);
  if (!user) return err(c, 401, "Please sign in.");
  if (!isAdmin(user)) return err(c, 403, "Support inbox is for admins only.");
  markAdminSeen();
  c.set("admin", user);
  await next();
});

adminChat.get("/conversations", async (c) => {
  const status = c.req.query("status") === "closed" ? "closed" : "open";
  const rows = await db
    .select({
      conv: chatConversations,
      plan: users.plan,
      lastBody: sql<string>`(select body from chat_messages m where m.conversation_id = ${chatConversations.id} order by m.id desc limit 1)`,
      lastSender: sql<string>`(select sender from chat_messages m where m.conversation_id = ${chatConversations.id} order by m.id desc limit 1)`,
    })
    .from(chatConversations)
    .leftJoin(users, eq(users.id, chatConversations.userId))
    .where(eq(chatConversations.status, status))
    .orderBy(desc(chatConversations.lastMessageAt))
    .limit(200);
  const [{ unread }] = await db
    .select({ unread: sql<number>`coalesce(sum(${chatConversations.unreadByAdmin}), 0)::int` })
    .from(chatConversations)
    .where(eq(chatConversations.status, "open"));
  return c.json({
    unreadTotal: unread,
    conversations: rows.map((r) => ({
      id: r.conv.id,
      name: r.conv.name,
      email: r.conv.email,
      status: r.conv.status,
      unread: r.conv.unreadByAdmin,
      lastMessageAt: r.conv.lastMessageAt,
      preview: r.lastBody,
      lastSender: r.lastSender,
      plan: r.plan,
      visitorTyping: typingUntil(r.conv.id, "visitor") !== null,
    })),
  });
});

async function loadConversation(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db
    .select({ conv: chatConversations, plan: users.plan, subStatus: subscriptions.status })
    .from(chatConversations)
    .leftJoin(users, eq(users.id, chatConversations.userId))
    .leftJoin(subscriptions, eq(subscriptions.userId, chatConversations.userId))
    .where(eq(chatConversations.id, id));
  return row ?? null;
}

adminChat.get("/conversations/:id", async (c) => {
  const row = await loadConversation(c.req.param("id"));
  if (!row) return err(c, 404, "Conversation not found.");
  if (row.conv.unreadByAdmin > 0) {
    await db.update(chatConversations).set({ unreadByAdmin: 0 }).where(eq(chatConversations.id, row.conv.id));
    notify(row.conv.id);
  }
  const messages = await messagesAfter(row.conv.id, 0);
  return c.json({
    conversation: {
      id: row.conv.id,
      name: row.conv.name,
      email: row.conv.email,
      status: row.conv.status,
      page: row.conv.page,
      createdAt: row.conv.createdAt,
      account: row.plan ? { plan: row.plan, subscriptionStatus: row.subStatus } : null,
      visitorUnread: row.conv.unreadByVisitor,
    },
    messages: messages.map(publicMessage),
    /** Epoch ms until which the visitor counts as typing (null = not typing). */
    visitorTypingUntil: typingUntil(row.conv.id, "visitor"),
  });
});

adminChat.post("/conversations/:id/messages", async (c) => {
  const row = await loadConversation(c.req.param("id"));
  if (!row) return err(c, 404, "Conversation not found.");
  const body = cleanBody(((await c.req.json().catch(() => ({}))) as Record<string, unknown>).body);
  if (!body) return err(c, 400, "Write a reply first.");
  if (body.length > MAX_BODY) return err(c, 400, `Keep it under ${MAX_BODY} characters.`);
  return c.json({ message: publicMessage(await postMessage(row.conv, "admin", body, c.get("admin").id)) });
});

/** Admin typing indicator, shown to the visitor as "InterviewVeil is typing…". */
adminChat.post("/conversations/:id/typing", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return err(c, 404, "Conversation not found.");
  const isTyping = ((await c.req.json().catch(() => ({}))) as { typing?: unknown }).typing === true;
  if (setTyping(id, "admin", isTyping) || isTyping) notifyVisitor(id);
  return c.json({ ok: true });
});

adminChat.post("/conversations/:id/status", async (c) => {
  const row = await loadConversation(c.req.param("id"));
  if (!row) return err(c, 404, "Conversation not found.");
  const status = ((await c.req.json().catch(() => ({}))) as { status?: string }).status;
  if (status !== "open" && status !== "closed") return err(c, 400, "Status must be open or closed.");
  await db.update(chatConversations).set({ status }).where(eq(chatConversations.id, row.conv.id));
  notify(row.conv.id);
  return c.json({ ok: true, status });
});

/** Long-poll: resolves when any conversation changes (or after ~25s). Also keeps "Online" status. */
adminChat.get("/updates", async (c) => {
  await waitFor(ADMIN_EVENT, LONG_POLL_MS, c.req.raw.signal);
  markAdminSeen();
  return c.json({ ok: true });
});
