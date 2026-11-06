/**
 * Pure slot-grid logic (no network, no googleapis import).
 *
 * The bookable grid is: weekdays (Mon–Fri) in IST, 30-minute slots that START
 * between 08:00 and 18:30 inclusive, within the next 14 days.
 *
 * Everything that books a slot (chat, voice) validates against `isValidSlotStart`
 * so a tampered request can never create an event outside this grid.
 * All date maths is done on explicit IST offsets – never on the server's local
 * time zone.
 */

export interface Slot {
  start: string;
  end: string;
}

export const BOOKING_TZ = "Asia/Kolkata";
export const IST_OFFSET_MS = (5 * 60 + 30) * 60_000; // IST has no DST
export const SLOT_MS = 30 * 60_000;
export const DAY_MS = 24 * 60 * 60_000;
export const HORIZON_DAYS = 14;
export const FIRST_SLOT_HOUR = 8;  // 08:00 IST
export const LAST_SLOT_HOUR = 18;  // last slot starts 18:30 IST

/** Wall-clock parts of an instant in IST. `weekday`: 0 = Sunday … 6 = Saturday. */
export function istParts(ms: number) {
  const d = new Date(ms + IST_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return {
    year: y,
    month: m,
    day,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
    /** Stable per-IST-day key, e.g. "2030-03-04". */
    dateKey: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** True if `ms` is a valid, future, in-horizon start of a bookable slot. */
export function isValidSlotStart(ms: number, nowMs: number = Date.now()): boolean {
  if (!Number.isFinite(ms)) return false;
  if (ms <= nowMs || ms >= nowMs + HORIZON_DAYS * DAY_MS) return false;
  if (ms % SLOT_MS !== 0) return false; // IST offset is a multiple of 30 min, so this is "on the half hour in IST"
  const p = istParts(ms);
  if (p.weekday === 0 || p.weekday === 6) return false;
  return p.hour >= FIRST_SLOT_HOUR && p.hour <= LAST_SLOT_HOUR;
}

export function toSlot(startMs: number): Slot {
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + SLOT_MS).toISOString(),
  };
}

/** All grid slots with `from < start < to`. */
export function generateSlotGrid(from: Date, to: Date): { start: Date; end: Date }[] {
  const slots: { start: Date; end: Date }[] = [];
  const base = istParts(from.getTime());
  const totalDays = Math.ceil((to.getTime() - from.getTime()) / DAY_MS);

  for (let d = 0; d <= totalDays; d++) {
    const dayMs = Date.UTC(base.year, base.month - 1, base.day + d);
    const wd = new Date(dayMs).getUTCDay();
    if (wd === 0 || wd === 6) continue;

    for (let hour = FIRST_SLOT_HOUR; hour <= LAST_SLOT_HOUR; hour++) {
      for (const min of [0, 30]) {
        const startMs = Date.UTC(base.year, base.month - 1, base.day + d, hour, min) - IST_OFFSET_MS;
        if (startMs > from.getTime() && startMs < to.getTime()) {
          slots.push({ start: new Date(startMs), end: new Date(startMs + SLOT_MS) });
        }
      }
    }
  }
  return slots;
}

const NAIVE_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * Parse a slot time supplied by a client or an LLM.
 * An ISO string with NO zone designator is interpreted as IST (the caller's
 * frame of reference), not as the server's zone. Returns epoch ms or null.
 */
export function parseSlotTime(input: unknown): number | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (s.length === 0 || s.length > 40) return null;
  // Only ISO-8601-shaped input: V8's legacy Date.parse accepts junk like "tomorrow at 10".
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) return null;
  const iso = NAIVE_ISO.test(s) ? `${s.replace(" ", "T")}+05:30` : s;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Snap to the nearest half-hour if within `toleranceMs` (LLM/transcript drift); else unchanged. */
export function snapToGrid(ms: number, toleranceMs = 2 * 60_000): number {
  const nearest = Math.round(ms / SLOT_MS) * SLOT_MS;
  return Math.abs(nearest - ms) <= toleranceMs ? nearest : ms;
}
