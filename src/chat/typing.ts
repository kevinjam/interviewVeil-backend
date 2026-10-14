/**
 * Ephemeral "is typing" state, kept in memory only (never persisted).
 * Clients re-announce every few seconds while typing; an entry that isn't
 * refreshed expires on its own, so a closed tab never leaves dots stuck on.
 */
export const TYPING_TTL_MS = 6_000;

type Side = "visitor" | "admin";

const typing = new Map<string, Partial<Record<Side, number>>>(); // conversationId → expiry (ms epoch)

/** Record (or clear) typing. Returns true if the visible state changed. */
export function setTyping(conversationId: string, side: Side, isTyping: boolean, now = Date.now()): boolean {
  const entry = typing.get(conversationId) ?? {};
  const wasTyping = (entry[side] ?? 0) > now;
  if (isTyping) entry[side] = now + TYPING_TTL_MS;
  else delete entry[side];
  if (entry.visitor || entry.admin) typing.set(conversationId, entry);
  else typing.delete(conversationId);
  return wasTyping !== isTyping;
}

/** Epoch ms until which `side` counts as typing, or null. */
export function typingUntil(conversationId: string, side: Side, now = Date.now()): number | null {
  const until = typing.get(conversationId)?.[side];
  return until && until > now ? until : null;
}

// Drop stale entries now and then so the map can't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of typing) {
    if ((entry.visitor ?? 0) <= now && (entry.admin ?? 0) <= now) typing.delete(id);
  }
}, 60_000).unref();
