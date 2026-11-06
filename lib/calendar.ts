import { google } from "googleapis";
import { OWNER_CALENDAR_ATTENDEE, OWNER_EMAIL, OWNER_NAME } from "./config";
import { isValidEmail } from "./email";
import {
  BOOKING_TZ,
  DAY_MS,
  HORIZON_DAYS,
  SLOT_MS,
  generateSlotGrid,
  isValidSlotStart,
  toSlot,
  type Slot,
} from "./slots";

export type { Slot } from "./slots";

// ── Auth (memoised: avoids a fresh OAuth client + token refresh per call) ──

type OAuthClient = InstanceType<typeof google.auth.OAuth2>;
let _auth: { key: string; client: OAuthClient } | null = null;

function getAuth(): OAuthClient {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  const refresh = process.env.GOOGLE_REFRESH_TOKEN;
  const key = `${id}|${secret}|${refresh}`;
  if (_auth?.key === key) return _auth.client;

  const client = new google.auth.OAuth2(id, secret, "http://localhost");
  client.setCredentials({ refresh_token: refresh });
  _auth = { key, client };
  return client;
}

function getCalendar() {
  return google.calendar({ version: "v3", auth: getAuth() });
}

// ── Availability ────────────────────────────────────────────────

/** Raised when the calendar cannot be read – distinct from "no free slots". */
export class CalendarUnavailableError extends Error {
  constructor(message = "Calendar unavailable") {
    super(message);
    this.name = "CalendarUnavailableError";
  }
}

type Busy = { start?: string | null; end?: string | null };

async function queryBusy(timeMin: Date, timeMax: Date): Promise<Busy[]> {
  const res = await getCalendar().freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone: BOOKING_TZ,
      items: [{ id: "primary" }],
    },
  });
  const primary = res.data.calendars?.primary;
  if (primary?.errors?.length) throw new Error("freebusy reported calendar errors");
  return primary?.busy ?? [];
}

function overlapsBusy(startMs: number, endMs: number, busy: Busy[]): boolean {
  return busy.some((b) => {
    const bs = Date.parse(b.start ?? "");
    const be = Date.parse(b.end ?? "");
    return startMs < be && endMs > bs;
  });
}

/**
 * Free slots over the next 2 weeks, chronological, up to `maxSlots`.
 * Throws `CalendarUnavailableError` if the calendar can't be read.
 */
export async function listFreeSlots(maxSlots = 200): Promise<Slot[]> {
  const now = new Date();
  const horizon = new Date(now.getTime() + HORIZON_DAYS * DAY_MS);
  let busy: Busy[];
  try {
    busy = await queryBusy(now, horizon);
  } catch (e) {
    console.error("Google Calendar freebusy error:", e instanceof Error ? e.message : "unknown");
    throw new CalendarUnavailableError();
  }
  return generateSlotGrid(now, horizon)
    .filter((s) => !overlapsBusy(s.start.getTime(), s.end.getTime(), busy))
    .slice(0, maxSlots)
    .map((s) => toSlot(s.start.getTime()));
}

/** Backwards-compatible wrapper: returns [] on failure. Prefer `listFreeSlots`. */
export async function getAvailableSlots(maxSlots = 200): Promise<Slot[]> {
  try {
    return await listFreeSlots(maxSlots);
  } catch {
    return [];
  }
}

// ── Booking ─────────────────────────────────────────────────────

export type BookingCode = "ok" | "invalid_slot" | "slot_taken" | "invalid_input" | "calendar_error";

export interface BookingOutcome {
  success: boolean;
  code: BookingCode;
  /** Safe to show to the end user (never contains raw provider errors). */
  message: string;
}

const MAX_NAME_LEN = 80;

function cleanName(name: unknown): string {
  const s = typeof name === "string" ? name : "";
  const cleaned = s.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LEN);
  return cleaned || "Guest";
}

/**
 * Per-slot mutex (within one server instance). Chat and voice both go through
 * `createBooking`, so two callers racing for the same slot are serialised and
 * the second one sees the first one's event in its freebusy re-check.
 * Across serverless instances the window is the latency of one freebusy+insert;
 * Google Calendar has no transactions, so this is the best available guard.
 */
const slotLocks = new Map<number, Promise<unknown>>();

async function withSlotLock<T>(key: number, fn: () => Promise<T>): Promise<T> {
  const previous = slotLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  slotLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (slotLocks.get(key) === run) slotLocks.delete(key);
  }
}

const fail = (code: BookingCode, message: string): BookingOutcome => ({ success: false, code, message });

/**
 * Create the calendar event. The ONLY function that writes to the calendar.
 *
 * Never trusts the caller's slot: only `slot.start` is used, and it must be on
 * the bookable grid (weekday, 08:00–18:30 IST, half-hour, future, ≤14 days).
 * `end` is always start + 30 min. Availability is re-checked against freebusy
 * immediately before insert, under a per-slot lock.
 */
export async function createBooking(name: string, email: string, slot: Slot): Promise<BookingOutcome> {
  if (!isValidEmail(email)) {
    return fail("invalid_input", "That email address doesn't look valid. Could you share it again?");
  }
  const startMs = Date.parse(slot?.start ?? "");
  if (!isValidSlotStart(startMs)) {
    return fail("invalid_slot", "That time isn't one of my bookable slots (weekdays, 8:00 AM–6:30 PM IST, within the next 2 weeks).");
  }
  const safeName = cleanName(name);
  const { start, end } = toSlot(startMs);

  return withSlotLock(startMs, async () => {
    try {
      const busy = await queryBusy(new Date(startMs), new Date(startMs + SLOT_MS));
      if (overlapsBusy(startMs, startMs + SLOT_MS, busy)) {
        return fail("slot_taken", "Sorry — that slot was just taken.");
      }

      await getCalendar().events.insert({
        calendarId: "primary",
        sendUpdates: "all",
        conferenceDataVersion: 1,
        requestBody: {
          summary: `Interview with ${safeName}`,
          description: `30-minute interview call with ${safeName} (${email}) and ${OWNER_NAME}`,
          start: { dateTime: start, timeZone: BOOKING_TZ },
          end: { dateTime: end, timeZone: BOOKING_TZ },
          attendees: [
            { email: OWNER_CALENDAR_ATTENDEE, displayName: OWNER_NAME },
            { email, displayName: safeName },
          ],
          conferenceData: {
            createRequest: {
              requestId: `meet-${crypto.randomUUID()}`,
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        },
      });

      return {
        success: true,
        code: "ok" as const,
        message: `✅ Booked! A calendar invite has been sent to ${email} with a Google Meet link.`,
      };
    } catch (e) {
      console.error("Google Calendar createBooking error:", e instanceof Error ? e.message : "unknown");
      return fail("calendar_error", `I couldn't complete the booking just now. Please try again in a moment, or email me at ${OWNER_EMAIL}.`);
    }
  });
}

export function formatSlots(slots: Slot[]): string {
  if (slots.length === 0) return "No available slots found in the next 2 weeks.";
  return slots
    .map((s, i) => {
      const d = new Date(s.start);
      return `${i + 1}. ${d.toLocaleDateString("en-IN", { weekday: "long", month: "short", day: "numeric", timeZone: BOOKING_TZ })} at ${d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: BOOKING_TZ })} IST`;
    })
    .join("\n");
}
