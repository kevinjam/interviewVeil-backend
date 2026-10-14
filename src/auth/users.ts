import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { oauthAccounts, users, type User } from "../db/schema.js";
import { createAudioBalance } from "../audio.js";
import { createBalance } from "../tokens.js";
import { deleteAllSessions } from "./sessions.js";

export function normalizeEmail(email: string): string | null {
  const e = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return user ?? null;
}

/** Creates the user and their free-plan token balance atomically. */
export async function createUser(input: {
  email: string;
  name?: string | null;
  passwordHash?: string | null;
  emailVerified?: boolean;
}): Promise<User> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: input.email,
        name: input.name ?? null,
        passwordHash: input.passwordHash ?? null,
        emailVerified: input.emailVerified ?? false,
      })
      .returning();
    await createBalance(tx, user.id);
    await createAudioBalance(tx, user.id);
    return user;
  });
}

export interface OAuthProfile {
  provider: "google" | "github";
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

/**
 * Sign in with a provider: reuse the linked account, else link by verified
 * email, else create a new user.
 */
export async function upsertOAuthUser(profile: OAuthProfile): Promise<User> {
  const [linked] = await db
    .select({ user: users })
    .from(oauthAccounts)
    .innerJoin(users, eq(users.id, oauthAccounts.userId))
    .where(
      and(
        eq(oauthAccounts.provider, profile.provider),
        eq(oauthAccounts.providerUserId, profile.providerUserId),
      ),
    );
  if (linked) return linked.user;

  if (!profile.emailVerified) {
    throw new Error(`Your ${profile.provider} email isn't verified. Verify it there, or sign up with email.`);
  }

  let user = await findUserByEmail(profile.email);
  if (user && !user.emailVerified) {
    // Someone may have registered this address with a password without owning it.
    // The provider just proved ownership: drop that password and its sessions.
    [user] = await db
      .update(users)
      .set({ emailVerified: true, passwordHash: null, name: user.name ?? profile.name })
      .where(eq(users.id, user.id))
      .returning();
    await deleteAllSessions(user.id);
  }
  if (!user) {
    user = await createUser({ email: profile.email, name: profile.name, emailVerified: true });
  }

  await db
    .insert(oauthAccounts)
    .values({ provider: profile.provider, providerUserId: profile.providerUserId, userId: user.id })
    .onConflictDoNothing();
  return user;
}
