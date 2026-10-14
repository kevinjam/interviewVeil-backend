import { EventEmitter } from "node:events";

/**
 * In-process notifications for long-polling. Fine for a single API instance;
 * swap for Redis pub/sub (or Postgres LISTEN/NOTIFY) before running several.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

export const conversationEvent = (id: string) => `conversation:${id}`;
export const ADMIN_EVENT = "admin";

export function notify(conversationId: string): void {
  bus.emit(conversationEvent(conversationId));
  bus.emit(ADMIN_EVENT);
}

/** Wake only the visitor's long-poll (e.g. an admin started typing). */
export const notifyVisitor = (conversationId: string) => bus.emit(conversationEvent(conversationId));
/** Wake only the admins' long-poll (e.g. the visitor started typing). */
export const notifyAdmins = () => bus.emit(ADMIN_EVENT);

/** Resolve when `event` fires, after `ms`, or when the client disconnects. */
export function waitFor(event: string, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      bus.off(event, done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    bus.once(event, done);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** When an admin last had the support inbox open (drives the "Online" status). */
let adminSeenAt = 0;
export const markAdminSeen = () => {
  adminSeenAt = Date.now();
};
export const adminRecentlySeen = (withinMs = 90_000) => Date.now() - adminSeenAt < withinMs;
