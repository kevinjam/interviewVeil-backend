import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const planEnum = pgEnum("plan", ["free", "essential", "professional", "expert"]);
export const paidPlanEnum = pgEnum("paid_plan", ["essential", "professional", "expert"]);
export const sessionKindEnum = pgEnum("session_kind", ["web", "desktop"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Always stored lower-cased. */
  email: text("email").notNull().unique(),
  name: text("name"),
  /** scrypt hash; null for OAuth-only accounts. */
  passwordHash: text("password_hash"),
  /** True once an OAuth provider (or a password reset email) has proven ownership. */
  emailVerified: boolean("email_verified").notNull().default(false),
  /** Effective plan right now; drives model routing and token allowance. */
  plan: planEnum("plan").notNull().default("free"),
  stripeCustomerId: text("stripe_customer_id").unique(),
  ...timestamps,
});

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    provider: text("provider", { enum: ["google", "github"] }).notNull(),
    providerUserId: text("provider_user_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerUserId] }), index().on(t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** sha256 of the session token; raw tokens are never stored. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: sessionKindEnum("kind").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);

/** One row per user: their current (or most recent) Stripe subscription. */
export const subscriptions = pgTable("subscriptions", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  stripeSubscriptionId: text("stripe_subscription_id").notNull().unique(),
  plan: paidPlanEnum("plan").notNull(),
  /** Stripe status: active, trialing, past_due, canceled, unpaid, incomplete… */
  status: text("status").notNull(),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  /** Downgrade scheduled for the next billing cycle. */
  pendingPlan: paidPlanEnum("pending_plan"),
  ...timestamps,
});

export const tokenBalances = pgTable(
  "token_balance",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    balance: integer("balance").notNull(),
    /** Tokens granted per period for the plan that set this balance. */
    allowance: integer("allowance").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    updatedAt: timestamps.updatedAt,
  },
  (t) => [check("balance_non_negative", sql`${t.balance} >= 0`)],
);

export const audioBalances = pgTable(
  "audio_balance",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Seconds of transcription / listen time remaining this period. */
    balance: integer("balance").notNull(),
    allowance: integer("allowance").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    updatedAt: timestamps.updatedAt,
  },
  (t) => [check("audio_balance_non_negative", sql`${t.balance} >= 0`)],
);

export const usageHistory = pgTable(
  "usage_history",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    plan: planEnum("plan").notNull(),
    model: text("model").notNull(),
    tokensSpent: integer("tokens_spent").notNull().default(1),
    /** What the response was for (question, review, explain, follow_up), as reported by the app. */
    kind: text("kind"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.createdAt)],
);

/** Audit log of successful transcription requests (seconds charged). */
export const audioUsage = pgTable(
  "audio_usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    seconds: integer("seconds").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.createdAt)],
);

/** Desktop sign-in handoff: the app polls while the user approves in the browser. */
export const desktopLogins = pgTable("desktop_logins", {
  id: text("id").primaryKey(),
  /** sha256 of the secret only the requesting app knows. */
  secretHash: text("secret_hash").notNull(),
  /** Short code shown in both the app and the browser so the user can match them. */
  userCode: text("user_code").notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const passwordResets = pgTable("password_resets", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export const chatStatusEnum = pgEnum("chat_status", ["open", "closed"]);
export const chatSenderEnum = pgEnum("chat_sender", ["visitor", "admin"]);

/** A support conversation started from the website's chat widget. */
export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** sha256 of the visitor's conversation token (kept in their browser). */
    visitorTokenHash: text("visitor_token_hash").notNull().unique(),
    name: text("name"),
    email: text("email").notNull(),
    /** Set when the visitor was signed in. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Page the chat was started from. */
    page: text("page"),
    status: chatStatusEnum("status").notNull().default("open"),
    /** Messages the other side hasn't read yet. */
    unreadByAdmin: integer("unread_by_admin").notNull().default(0),
    unreadByVisitor: integer("unread_by_visitor").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.status, t.lastMessageAt)],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),
    sender: chatSenderEnum("sender").notNull(),
    /** Which admin replied (null for visitor messages). */
    adminId: uuid("admin_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.conversationId, t.id)],
);

/** Stripe webhook idempotency. */
export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type ChatConversation = typeof chatConversations.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type Plan = (typeof planEnum.enumValues)[number];
export type PaidPlan = (typeof paidPlanEnum.enumValues)[number];
export type Subscription = typeof subscriptions.$inferSelect;
export type TokenBalance = typeof tokenBalances.$inferSelect;
