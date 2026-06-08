/**
 * Centralized configuration — shared types and constants.
 * Import from here instead of scattering magic values across files.
 */

import type { Slot } from "./calendar";

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

export const OWNER_NAME = "Vinay Kumar Chopra";
export const OWNER_EMAIL = "vinay.23bcs10174@sst.scaler.com";
export const OWNER_PHONE = "+91-8822091421";
export const OWNER_GITHUB = "https://github.com/HUN-sp";

export const GROQ_MODEL = "llama-3.3-70b-versatile";
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
