/**
 * Shared test setup. Requires a disposable Postgres database:
 *   DATABASE_URL=postgres://localhost:5432/interviewveil_test npm test
 * Every table is truncated before each test.
 */
import { sql } from "drizzle-orm";
import { db, pool, runMigrations } from "../src/db/client.js";

if (!process.env.DATABASE_URL?.includes("test")) {
  throw new Error("Refusing to run tests: DATABASE_URL must point at a database whose name contains 'test'.");
}

let migrated = false;

export async function resetDb() {
  if (!migrated) {
    await runMigrations();
    migrated = true;
  }
  await db.execute(sql`
    truncate users, oauth_accounts, sessions, subscriptions, token_balance, audio_balance, usage_history,
      audio_usage, desktop_logins, password_resets, stripe_events, chat_messages, chat_conversations restart identity cascade
  `);
}

export async function closeDb() {
  await pool.end();
}
