const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface SupportHours {
  days: Set<number>;
  startMin: number;
  endMin: number;
}

/** Parse "Mon-Fri 09:00-18:00" (also "Mon,Wed,Fri 10:00-16:00"). Returns null if invalid. */
export function parseHours(spec: string): SupportHours | null {
  const m = /^\s*([A-Za-z,\-\s]+?)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(spec);
  if (!m) return null;
  const idx = (d: string) => DAYS.findIndex((x) => x.toLowerCase() === d.trim().slice(0, 3).toLowerCase());
  const days = new Set<number>();
  for (const part of m[1].split(",")) {
    const [a, b] = part.split("-").map(idx);
    if (a < 0 || (b !== undefined && b < 0)) return null;
    if (b === undefined) days.add(a);
    else for (let d = a; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === b) break;
    }
  }
  const startMin = Number(m[2]) * 60 + Number(m[3]);
  const endMin = Number(m[4]) * 60 + Number(m[5]);
  return endMin > startMin ? { days, startMin, endMin } : null;
}

/** Is `now` inside the support hours, evaluated in `timeZone`? */
export function withinHours(hours: SupportHours, timeZone: string, now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = DAYS.indexOf(get("weekday"));
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return hours.days.has(day) && minutes >= hours.startMin && minutes < hours.endMin;
}
