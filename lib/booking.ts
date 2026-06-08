/**
 * Booking state machine — extracted from the old 587-line chat/route.ts.
 *
 * Handles the complete booking flow:
 *   idle → day_shown → slots_shown → awaiting_email → booked → idle
 *
 * Each handler returns either:
 *   { type: "response", data }    — booking action handled, return this response
 *   { type: "not_booking", state } — message isn't booking-related; caller should
 *                                     handle it (RAG chat) and preserve this state
 */

import { getAvailableSlots, createBooking, type Slot } from "./calendar";
import { isOffTopic } from "./router";
import type { BookingStep, BookingState, ChatResponse } from "./config";
import { OWNER_EMAIL, idleState } from "./config";

// ── Result type ─────────────────────────────────────────────────

export type BookingResult =
  | { type: "response"; data: ChatResponse }
  | { type: "not_booking"; state: BookingState };

// ── Request body (what the route passes in) ─────────────────────

export interface BookingInput {
  lastMsg: string;
  bookingStep: BookingStep;
  allSlots: Slot[] | null;
  pendingSlots: Slot[] | null;
  selectedSlot: Slot | null;
  slotPage: number;
}

// ── Internal constants ──────────────────────────────────────────

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
const DAY_ALIASES: Record<string, string> = {
  monday: "monday", mon: "monday",
  tuesday: "tuesday", tue: "tuesday",
  wednesday: "wednesday", wed: "wednesday",
  thursday: "thursday", thu: "thursday",
  friday: "friday", fri: "friday",
  saturday: "saturday", sat: "saturday",
  sunday: "sunday", sun: "sunday"
};
const NEG_WORDS = ["no", "not", "don't", "dont", "nope"];

// ── Formatting helpers ──────────────────────────────────────────

function slotTimeLabel(s: Slot): string {
  const ist = new Date(new Date(s.start).getTime() + IST_OFFSET_MS);
  const h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} IST`;
}

function slotWeekday(s: Slot): string {
  return new Date(s.start)
    .toLocaleDateString("en-US", { weekday: "long" })
    .toLowerCase();
}

function formatReadableSlot(d: Date): string {
  return `${d.toLocaleDateString("en-IN", { weekday: "long", month: "short", day: "numeric" })} at ${d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST`;
}

// Groups slots by calendar date → ordered list of unique days
function getUniqueDays(slots: Slot[]): { dateStr: string; label: string; slots: Slot[] }[] {
  const map = new Map<string, { label: string; slots: Slot[] }>();
  for (const slot of slots) {
    const d = new Date(slot.start);
    const dateStr = d.toDateString();
    if (!map.has(dateStr)) {
      map.set(dateStr, {
        label: d.toLocaleDateString("en-IN", { weekday: "long", month: "short", day: "numeric" }),
        slots: [],
      });
    }
    map.get(dateStr)!.slots.push(slot);
  }
  return Array.from(map.entries()).map(([dateStr, v]) => ({ dateStr, ...v }));
}

/** Day summary: "1. Monday, 9 Jun — 22 slots" */
function formatDaySummary(slots: Slot[]): string {
  return getUniqueDays(slots)
    .map((d, i) => `${i + 1}. ${d.label} — ${d.slots.length} slot${d.slots.length > 1 ? "s" : ""}`)
    .join("\n");
}

/** Time list for one day: "1. 9:00 AM IST" */
function formatDaySlots(slots: Slot[]): string {
  return slots.map((s, i) => `${i + 1}. ${slotTimeLabel(s)}`).join("\n");
}

// ── Parsing helpers ─────────────────────────────────────────────

/** Parses "9:30 am", "9:30", "10am" → { hour, minute } */
function parseTime(message: string): { hour: number; minute: number } | null {
  const colonMatch = message.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  if (colonMatch) {
    let h = parseInt(colonMatch[1]),
      m = parseInt(colonMatch[2]);
    const mer = colonMatch[3]?.toLowerCase();
    if (mer === "pm" && h !== 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    if (h >= 0 && h < 24 && m >= 0 && m < 60) return { hour: h, minute: m };
  }
  const shortMatch = message.match(/\b(\d{1,2})\s*(am|pm)\b/i);
  if (shortMatch) {
    let h = parseInt(shortMatch[1]);
    const mer = shortMatch[2].toLowerCase();
    if (mer === "pm" && h !== 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    if (h >= 0 && h < 24) return { hour: h, minute: 0 };
  }
  return null;
}

/** Parses "15 April", "April 15", "15th April" → Date */
function parseDateFromText(message: string): Date | null {
  const lower = message.toLowerCase();
  const monthAliases = [
    ["january", "jan"], ["february", "feb"], ["march", "mar"],
    ["april", "apr"], ["may"], ["june", "jun"],
    ["july", "jul"], ["august", "aug"], ["september", "sep", "sept"],
    ["october", "oct"], ["november", "nov"], ["december", "dec"],
  ];
  for (let mi = 0; mi < monthAliases.length; mi++) {
    const m = monthAliases[mi].find((alias) => lower.includes(alias));
    if (!m) continue;
    const before = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s*${m}`).exec(lower);
    if (before) return new Date(new Date().getFullYear(), mi, parseInt(before[1]));
    const after = new RegExp(`${m}\\s*(\\d{1,2})(?:st|nd|rd|th)?`).exec(lower);
    if (after) return new Date(new Date().getFullYear(), mi, parseInt(after[1]));
  }
  return null;
}

/** Detect which day the user picked from the day-summary screen */
function detectDayChoice(
  message: string,
  allSlots: Slot[]
): { daySlots: Slot[]; dayLabel: string } | null {
  const lower = message.toLowerCase();
  const uniqueDays = getUniqueDays(allSlots);

  // 1. Number pick (1–N days) - exact match only to avoid matching "19" in "Friday 19 Jun"
  const numMatch = lower.match(/^\s*(\d{1,2})\s*\.?\s*$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1]) - 1;
    if (uniqueDays[idx]) return { daySlots: uniqueDays[idx].slots, dayLabel: uniqueDays[idx].label };
  }

  // 2. Explicit date: "14 Apr", "April 15th" (Check before day name to prevent wrong Friday selection)
  const parsed = parseDateFromText(message);
  if (parsed) {
    const entry = uniqueDays.find((d) => d.dateStr === parsed.toDateString());
    if (entry) return { daySlots: entry.slots, dayLabel: entry.label };
  }

  // 3. today / tomorrow
  const todayStr = new Date().toDateString();
  const tomorrowStr = new Date(Date.now() + 86_400_000).toDateString();
  const rel = lower.includes("tomorrow") ? tomorrowStr : lower.includes("today") ? todayStr : null;
  if (rel) {
    const entry = uniqueDays.find((d) => d.dateStr === rel);
    if (entry) return { daySlots: entry.slots, dayLabel: entry.label };
  }

  // 4. Day name fallback
  for (const [alias, fullDay] of Object.entries(DAY_ALIASES)) {
    // Only match standalone words (e.g. "wed", not "wedding")
    const regex = new RegExp(`\\b${alias}\\b`);
    if (!regex.test(lower)) continue;
    const entry = uniqueDays.find((d) => slotWeekday(d.slots[0]) === fullDay);
    if (entry) return { daySlots: entry.slots, dayLabel: entry.label };
  }

  return null;
}

type SlotDetection =
  | { type: "found"; slot: Slot }
  | { type: "ambiguous_day"; daySlots: Slot[]; dayName: string }
  | { type: "ambiguous_time"; timeSlots: Slot[]; timeLabel: string }
  | { type: "not_found" };

/** Detect which time slot the user picked */
function detectSlotChoice(message: string, slots: Slot[]): SlotDetection {
  const lower = message.toLowerCase();

  // Number pick (1–N) - exact match only to avoid matching "1" in "1 pm"
  const numMatch = lower.match(/^\s*(\d{1,2})\s*\.?\s*$/);
  if (numMatch) {
    const num = parseInt(numMatch[1]);
    if (num >= 1 && slots[num - 1]) return { type: "found", slot: slots[num - 1] };
  }

  const parsedTime = parseTime(message);

  // Day name match
  for (const [alias, fullDay] of Object.entries(DAY_ALIASES)) {
    const regex = new RegExp(`\\b${alias}\\b`);
    if (!regex.test(lower)) continue;
    const daySlots = slots.filter(
      (s) => new Date(s.start).toLocaleDateString("en-US", { weekday: "long" }).toLowerCase() === fullDay
    );
    if (daySlots.length === 0) continue;
    if (parsedTime) {
      const exact = daySlots.find((s) => {
        const ist = new Date(new Date(s.start).getTime() + IST_OFFSET_MS);
        return ist.getUTCHours() === parsedTime.hour && ist.getUTCMinutes() === parsedTime.minute;
      });
      if (exact) return { type: "found", slot: exact };
    }
    if (daySlots.length === 1) return { type: "found", slot: daySlots[0] };
    return { type: "ambiguous_day", daySlots, dayName: fullDay };
  }

  // Time-only match
  if (parsedTime) {
    const timeMatches = slots.filter((s) => {
      const ist = new Date(new Date(s.start).getTime() + IST_OFFSET_MS);
      return ist.getUTCHours() === parsedTime.hour && ist.getUTCMinutes() === parsedTime.minute;
    });
    if (timeMatches.length === 1) return { type: "found", slot: timeMatches[0] };
    if (timeMatches.length > 1) {
      const h = parsedTime.hour, m = parsedTime.minute;
      const timeLabel = `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
      return { type: "ambiguous_time", timeSlots: timeMatches, timeLabel };
    }
  }

  // today / tomorrow shorthand
  const relativeDay = lower.includes("tomorrow")
    ? new Date(Date.now() + 86_400_000).toDateString()
    : lower.includes("today")
      ? new Date().toDateString()
      : null;
  if (relativeDay) {
    const relSlots = slots.filter((s) => new Date(s.start).toDateString() === relativeDay);
    if (relSlots.length === 1) return { type: "found", slot: relSlots[0] };
    if (relSlots.length > 1) {
      const label = lower.includes("tomorrow") ? "tomorrow" : "today";
      return { type: "ambiguous_day", daySlots: relSlots, dayName: label };
    }
  }

  // Explicit date: "15 April"
  const parsedDate = parseDateFromText(message);
  if (parsedDate) {
    const dateStr = parsedDate.toDateString();
    const dateSlots = slots.filter((s) => new Date(s.start).toDateString() === dateStr);
    if (dateSlots.length === 1) return { type: "found", slot: dateSlots[0] };
    if (dateSlots.length > 1) {
      const dayName = parsedDate.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
      return { type: "ambiguous_day", daySlots: dateSlots, dayName };
    }
  }

  return { type: "not_found" };
}

/** Extract email from free text */
function extractEmail(message: string): string | null {
  const match = message.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

/** Extract name from free text (best-effort) */
function extractName(message: string, email: string): string {
  const cleaned = message.replace(email, "").replace(/[,]/g, " ").trim();
  const nameMatch = cleaned.match(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/);
  if (nameMatch) return nameMatch[1];
  const words = cleaned.replace(/[^a-zA-Z ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 2).join(" ");
  if (words.length === 1) return words[0];
  return "Guest";
}

// ── Public: booking handlers ────────────────────────────────────

/** Cancel an active booking → reset to idle with a friendly message. */
export function handleCancel(): ChatResponse {
  return {
    reply: "No worries at all! Feel free to ask anything else about my background, skills, or projects. You can also reach me at " + OWNER_EMAIL + " whenever you're ready to schedule.",
    ...idleState(),
  };
}

/** Start a new booking flow → fetch slots, show day summary. */
export async function handleBookingStart(): Promise<ChatResponse> {
  const slots = await getAvailableSlots();
  if (slots.length === 0) {
    return {
      reply: `I don't have any open slots in the next 2 weeks. Reach out directly at ${OWNER_EMAIL} to arrange a time.`,
      ...idleState(),
    };
  }
  return {
    reply: `Here are the days I'm available in the next 2 weeks:\n\n${formatDaySummary(slots)}\n\nWhich day works for you? Reply with a number or day name.`,
    bookingStep: "day_shown",
    allSlots: slots,
    pendingSlots: slots,
    selectedSlot: null,
    slotPage: 0,
  };
}

/**
 * Continue an active booking flow.
 *
 * Returns { type: "response", data } if the message was handled as a booking action.
 * Returns { type: "not_booking", state } if the message isn't booking-related
 * — the caller should answer it via RAG chat and preserve the booking state.
 */
export async function handleBookingContinue(input: BookingInput): Promise<BookingResult> {
  switch (input.bookingStep) {
    case "day_shown":
      return handleDayShown(input);
    case "slots_shown":
      return handleSlotsShown(input);
    case "awaiting_email":
      return handleAwaitingEmail(input);
    default:
      return { type: "not_booking", state: idleState() };
  }
}

/**
 * Generate a booking-step-appropriate reminder string.
 * Appended to RAG answers when user asks questions mid-booking.
 */
export function getBookingReminder(state: BookingState): string {
  switch (state.bookingStep) {
    case "day_shown":
      if (state.pendingSlots) {
        return `Whenever you're ready to continue booking, here are the available days:\n\n${formatDaySummary(state.pendingSlots)}`;
      }
      return "Let me know when you'd like to continue booking.";

    case "slots_shown":
      if (state.pendingSlots) {
        return `Here are the available times when you're ready:\n\n${formatDaySlots(state.pendingSlots)}`;
      }
      return "Let me know when you'd like to pick a time.";

    case "awaiting_email":
      return "Whenever you're ready, please share your **name and email** to confirm the booking.";

    default:
      return "";
  }
}

// ── Step handlers (private) ─────────────────────────────────────

/** day_shown: user should pick a day from the summary */
function handleDayShown(input: BookingInput): BookingResult {
  const { lastMsg, allSlots, pendingSlots } = input;
  if (!pendingSlots) return { type: "not_booking", state: idleState() };

  const lower = lastMsg.toLowerCase();
  
  // Correction check to distinguish negation from correction/selection
  const isCorrection = /\b(mean|actually|want|book|schedule|how about|what about|change|instead|prefer|choose|pick)\b/.test(lower) || 
                       /\b(no|nope)\b\s*,/.test(lower) ||
                       (parseDateFromText(lastMsg) !== null) ||
                       /^\s*\d{1,2}\s*$/.test(lower);

  const hasNeg = NEG_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(lower));
  const isNegation = hasNeg && !isCorrection;

  let negDay: string | undefined;
  if (isNegation) {
    for (const [alias, fullDay] of Object.entries(DAY_ALIASES)) {
      if (new RegExp(`\\b${alias}\\b`).test(lower)) {
        negDay = fullDay;
        break;
      }
    }
  }

  // Negation + day name → exclude that day
  if (negDay) {
    const remaining = pendingSlots.filter((s) => slotWeekday(s) !== negDay);
    if (remaining.length === 0) {
      return response({
        reply: `No other days available in the next 2 weeks. Reach out at ${OWNER_EMAIL}.`,
        ...idleState(),
      });
    }
    const cap = negDay.charAt(0).toUpperCase() + negDay.slice(1);
    return response({
      reply: `No problem! Available days excluding ${cap}:\n\n${formatDaySummary(remaining)}\n\nWhich works?`,
      bookingStep: "day_shown",
      allSlots: allSlots ?? pendingSlots,
      pendingSlots: remaining,
      selectedSlot: null,
      slotPage: 0,
    });
  }

  // Day pick → show that day's time slots
  const dayChoice = detectDayChoice(lastMsg, pendingSlots);
  if (dayChoice) {
    return response({
      reply: `Here are my slots on **${dayChoice.dayLabel}**:\n\n${formatDaySlots(dayChoice.daySlots)}\n\nWhich time works?`,
      bookingStep: "slots_shown",
      allSlots: allSlots ?? pendingSlots,
      pendingSlots: dayChoice.daySlots,
      selectedSlot: null,
      slotPage: 0,
    });
  }

  // Not a day pick → fall through to RAG chat (preserving booking state)
  return {
    type: "not_booking",
    state: {
      bookingStep: "day_shown",
      allSlots,
      pendingSlots,
      selectedSlot: null,
      slotPage: 0,
    },
  };
}

/** slots_shown: user should pick a time slot */
function handleSlotsShown(input: BookingInput): BookingResult {
  const { lastMsg, allSlots, pendingSlots } = input;
  if (!pendingSlots) return { type: "not_booking", state: idleState() };

  const lower = lastMsg.toLowerCase();
  
  // Correction check to distinguish negation from correction/selection
  const isCorrection = /\b(mean|actually|want|book|schedule|how about|what about|change|instead|prefer|choose|pick)\b/.test(lower) || 
                       /\b(no|nope)\b\s*,/.test(lower) ||
                       (parseDateFromText(lastMsg) !== null) ||
                       /^\s*\d{1,2}\s*$/.test(lower);

  const hasNeg = NEG_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(lower));
  const isNegation = hasNeg && !isCorrection;

  let mentionedDay: string | undefined;
  for (const [alias, fullDay] of Object.entries(DAY_ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`).test(lower)) {
      mentionedDay = fullDay;
      break;
    }
  }

  // Switch day choice directly if the user names/specifies another available day
  const dayChoice = detectDayChoice(lastMsg, allSlots ?? pendingSlots);
  if (dayChoice && (!pendingSlots || !dayChoice.daySlots.every(s => pendingSlots.some(p => p.start === s.start)))) {
    if (!isNegation) {
      return response({
        reply: `Here are my slots on **${dayChoice.dayLabel}**:\n\n${formatDaySlots(dayChoice.daySlots)}\n\nWhich time works?`,
        bookingStep: "slots_shown",
        allSlots: allSlots ?? pendingSlots,
        pendingSlots: dayChoice.daySlots,
        selectedSlot: null,
        slotPage: 0,
      });
    }
  }

  // User wants a different day → go back to day summary
  const backSignals = ["different day", "other day", "back", "change day", "another day", "go back", "show days"];
  const wantsBack = backSignals.some((s) => lower.includes(s)) || (isNegation && mentionedDay);
  if (wantsBack) {
    const base = allSlots ?? ([] as Slot[]);
    const negDay = isNegation && mentionedDay ? mentionedDay : undefined;
    const filtered = negDay ? base.filter((s) => slotWeekday(s) !== negDay) : base;
    if (filtered.length === 0) {
      return response({
        reply: `No other days available in the next 2 weeks. Reach out at ${OWNER_EMAIL}.`,
        ...idleState(),
      });
    }
    const dayHint = negDay ? ` (excluding ${negDay.charAt(0).toUpperCase() + negDay.slice(1)})` : "";
    return response({
      reply: `Here are my available days${dayHint}:\n\n${formatDaySummary(filtered)}\n\nWhich works?`,
      bookingStep: "day_shown",
      allSlots: allSlots ?? base,
      pendingSlots: filtered,
      selectedSlot: null,
      slotPage: 0,
    });
  }

  // Detect specific time slot
  const detection = detectSlotChoice(lastMsg, pendingSlots);

  if (detection.type === "found") {
    const readable = formatReadableSlot(new Date(detection.slot.start));
    return response({
      reply: `Perfect — **${readable}** it is.\n\nPlease share your **name and email** to confirm the booking.`,
      bookingStep: "awaiting_email",
      allSlots,
      pendingSlots,
      selectedSlot: detection.slot,
      slotPage: 0,
    });
  }

  if (detection.type === "ambiguous_time") {
    const dayOpts = detection.timeSlots
      .map((s, i) => `${i + 1}. ${new Date(s.start).toLocaleDateString("en-IN", { weekday: "long", month: "short", day: "numeric" })}`)
      .join("\n");
    return response({
      reply: `${detection.timeLabel} IST is available on:\n\n${dayOpts}\n\nWhich day?`,
      bookingStep: "slots_shown",
      allSlots,
      pendingSlots: detection.timeSlots,
      selectedSlot: null,
      slotPage: 0,
    });
  }

  // Not a slot pick → fall through to RAG chat (preserving booking state)
  return {
    type: "not_booking",
    state: {
      bookingStep: "slots_shown",
      allSlots,
      pendingSlots,
      selectedSlot: null,
      slotPage: 0,
    },
  };
}

/** awaiting_email: user should provide name + email to finalize */
async function handleAwaitingEmail(input: BookingInput): Promise<BookingResult> {
  const { lastMsg, allSlots, pendingSlots, selectedSlot } = input;
  if (!selectedSlot) return { type: "not_booking", state: idleState() };

  const email = extractEmail(lastMsg);

  if (email) {
    // Got an email → book the slot
    const name = extractName(lastMsg, email);
    const result = await createBooking(name, email, selectedSlot);
    return response({
      reply: result.message,
      ...idleState(),
    });
  }

  // No email found — check if user is correcting slot or switching day
  if (pendingSlots) {
    const detection = detectSlotChoice(lastMsg, pendingSlots);
    if (detection.type === "found") {
      const readable = formatReadableSlot(new Date(detection.slot.start));
      return response({
        reply: `No problem — updated to **${readable}**.\n\nPlease share your **name and email** to confirm.`,
        bookingStep: "awaiting_email",
        allSlots,
        pendingSlots,
        selectedSlot: detection.slot,
        slotPage: 0,
      });
    }
  }

  if (allSlots) {
    const dayChoice = detectDayChoice(lastMsg, allSlots);
    if (dayChoice) {
      return response({
        reply: `Here are my slots on **${dayChoice.dayLabel}**:\n\n${formatDaySlots(dayChoice.daySlots)}\n\nWhich time works?`,
        bookingStep: "slots_shown",
        allSlots,
        pendingSlots: dayChoice.daySlots,
        selectedSlot: null,
        slotPage: 0,
      });
    }
  }

  // Message is neither email, slot correction, nor day change.
  // Fall through to RAG chat — the caller will answer the question
  // and remind about the booking. This fixes the "stuck asking for email" bug.
  return {
    type: "not_booking",
    state: {
      bookingStep: "awaiting_email",
      allSlots,
      pendingSlots,
      selectedSlot,
      slotPage: 0,
    },
  };
}

// ── Utility ─────────────────────────────────────────────────────

function response(data: ChatResponse): BookingResult {
  return { type: "response", data };
}
