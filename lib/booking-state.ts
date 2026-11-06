import type { BookingState, BookingStep } from "./config";
import { idleState } from "./config";
import { isValidSlotStart, toSlot, type Slot } from "./slots";

/**
 * The browser echoes booking state back on every request, so it is UNTRUSTED.
 * This rebuilds a clean state from it: every slot must lie on the bookable
 * grid (future, weekday, in hours, ≤14 days) and is re-serialised canonically
 * (so a forged `end` can never survive); inconsistent steps collapse to idle.
 *
 * It does not prove a slot is still free – `createBooking` re-checks freebusy
 * right before writing, which is what actually prevents double booking.
 */

const STEPS: ReadonlySet<string> = new Set<BookingStep>(["idle", "day_shown", "slots_shown", "awaiting_email"]);
export const MAX_CLIENT_SLOTS = 300; // 14 days × 22 slots ≈ 220 is the real maximum

function cleanSlots(raw: unknown, nowMs: number): Slot[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<number>();
  const out: Slot[] = [];
  for (const item of raw.slice(0, MAX_CLIENT_SLOTS)) {
    const start = typeof (item as Slot | null)?.start === "string" ? Date.parse((item as Slot).start) : NaN;
    if (!isValidSlotStart(start, nowMs) || seen.has(start)) continue;
    seen.add(start);
    out.push(toSlot(start));
  }
  return out.length > 0 ? out : null;
}

export function sanitizeBookingState(raw: unknown, nowMs: number = Date.now()): BookingState {
  if (!raw || typeof raw !== "object") return idleState();
  const r = raw as Record<string, unknown>;

  const step = typeof r.bookingStep === "string" && STEPS.has(r.bookingStep) ? (r.bookingStep as BookingStep) : "idle";
  if (step === "idle") return idleState();

  const pendingSlots = cleanSlots(r.pendingSlots, nowMs);
  const allSlots = cleanSlots(r.allSlots, nowMs) ?? pendingSlots;

  let selectedSlot: Slot | null = null;
  const selStart = typeof (r.selectedSlot as Slot | null)?.start === "string" ? Date.parse((r.selectedSlot as Slot).start) : NaN;
  if (isValidSlotStart(selStart, nowMs)) selectedSlot = toSlot(selStart);

  if (step === "awaiting_email") {
    if (!selectedSlot) return idleState();
    return { bookingStep: step, allSlots, pendingSlots, selectedSlot, slotPage: 0 };
  }

  // day_shown / slots_shown need something to choose from
  if (!pendingSlots) return idleState();
  return { bookingStep: step, allSlots, pendingSlots, selectedSlot: null, slotPage: 0 };
}
