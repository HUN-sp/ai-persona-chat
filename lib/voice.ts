/** Voice-agent slot selection/formatting (pure; unit-tested). */
import { BOOKING_TZ, istParts, type Slot } from "./slots";

/** Ordinal suffix: 1 → "1st", 23 → "23rd" (TTS reads these naturally). */
export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

export const VOICE_FIRST_HOUR = 9;   // 09:00 IST
export const VOICE_END_HOUR = 17;    // slots must START before 17:00 IST
export const VOICE_MAX_PER_DAY = 4;
export const VOICE_MAX_DAYS = 3;

/**
 * Pick slots to read aloud: 09:00–17:00 IST only, ≤4 per day, ≤3 days.
 * (Chat offers 08:00–18:30; voice is intentionally narrower.)
 * The IST hour comes from explicit offset maths, not `toLocaleTimeString`
 * (whose `hour12:false` yields "24" at midnight on some engines).
 */
export function selectVoiceSlots(slots: Slot[]): Slot[] {
  const byDay = new Map<string, Slot[]>();
  for (const s of slots) {
    const p = istParts(Date.parse(s.start));
    if (!(p.hour >= VOICE_FIRST_HOUR && p.hour < VOICE_END_HOUR)) continue;
    const list = byDay.get(p.dateKey) ?? [];
    if (list.length < VOICE_MAX_PER_DAY) list.push(s);
    byDay.set(p.dateKey, list);
  }
  const result: Slot[] = [];
  let days = 0;
  for (const daySlots of byDay.values()) {
    if (days >= VOICE_MAX_DAYS) break;
    result.push(...daySlots);
    days++;
  }
  return result;
}

/** Readable list with `slotTime=<ISO>` refs the LLM must not say aloud. */
export function formatSlotsForVoice(slots: Slot[]): string {
  const opts = (o: Intl.DateTimeFormatOptions, d: Date) =>
    d.toLocaleDateString("en-US", { ...o, timeZone: BOOKING_TZ });

  const lines: string[] = [];
  let n = 1;
  let lastKey = "";
  let label = "";
  for (const s of slots) {
    const d = new Date(s.start);
    const p = istParts(d.getTime());
    if (p.dateKey !== lastKey) {
      lastKey = p.dateKey;
      label = `${opts({ weekday: "long" }, d)}, ${opts({ month: "long" }, d)} ${ordinal(p.day)}`;
    }
    const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: BOOKING_TZ });
    lines.push(`Option ${n++}: ${label} at ${time} — slotTime=${s.start}`);
  }
  return lines.join("\n");
}
