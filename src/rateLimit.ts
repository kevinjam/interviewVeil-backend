/** In-memory sliding-window limiter (per process). Use Redis when running several instances. */
const windows = new Map<string, number[]>();

export function rateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  windows.set(key, recent);
  return recent.length > limit;
}

export function clientIp(header: string | undefined): string {
  return header?.split(",")[0]?.trim() || "local";
}
