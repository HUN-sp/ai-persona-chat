/**
 * Centralized configuration — shared types and constants.
 * Import from here instead of scattering magic values across files.
 */

import type { Slot } from "./calendar";
import { persona } from "../persona";

// ── Shared types ────────────────────────────────────────────────

export type BookingStep = "idle" | "day_shown" | "slots_shown" | "awaiting_email";

export interface BookingState {
  bookingStep: BookingStep;
  allSlots: Slot[] | null;
  pendingSlots: Slot[] | null;
  selectedSlot: Slot | null;
  slotPage: number;
}

export interface ChatResponse extends BookingState {
  reply: string;
}

// ── Constants ───────────────────────────────────────────────────

// Owner identity/contact come from the active persona (persona/<id>/persona.json).
export const OWNER_NAME = persona.owner.name;
export const OWNER_SHORT_NAME = persona.owner.shortName;
export const OWNER_EMAIL = persona.contact.email;
export const OWNER_PHONE = persona.contact.phone;
export const OWNER_GITHUB = persona.contact.github;

/** Calendar attendee added to every booking (override with OWNER_CALENDAR_EMAIL). */
export const OWNER_CALENDAR_ATTENDEE = process.env.OWNER_CALENDAR_EMAIL ?? persona.contact.calendarAttendeeEmail;

export const GROQ_MODEL = "llama-3.3-70b-versatile";
/** Low temperature: this is a grounded-answer bot, not a creative writer. Override with GROQ_TEMPERATURE. */
export const GROQ_TEMPERATURE = Number.isFinite(Number(process.env.GROQ_TEMPERATURE)) && process.env.GROQ_TEMPERATURE ? Number(process.env.GROQ_TEMPERATURE) : 0.3;
export const MAX_TOKENS_CHAT = 1024;
export const MAX_TOKENS_MIDFLOW = 512;

// ── Factory ─────────────────────────────────────────────────────

/** Returns a clean "idle" booking state (for resetting). */
export function idleState(): BookingState {
  return {
    bookingStep: "idle",
    allSlots: null,
    pendingSlots: null,
    selectedSlot: null,
    slotPage: 0,
  };
}
