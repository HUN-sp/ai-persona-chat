import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { calendarState, resetCalendar, FIXED_NOW } from "./helpers/google-mock";
import { resetRateLimits } from "@/lib/rate-limit";
import { jsonReq } from "./helpers/route";

vi.mock("googleapis", async () => (await import("./helpers/google-mock")).googleModuleFactory());
vi.mock("@/lib/retriever", () => ({ retrieve: vi.fn(async (q: string) => `CTX for ${q}`) }));

import { POST } from "@/app/api/vapi/webhook/route";
import { selectVoiceSlots, formatSlotsForVoice, ordinal } from "@/lib/voice";
import { toSlot } from "@/lib/slots";

const IST = 330 * 60_000;
const istIso = (date: string, hhmm: string) => {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, mi) - IST).toISOString();
};

async function call(name: string, args: Record<string, unknown>, id = "tc1") {
  const res = await POST(
    jsonReq("/api/vapi/webhook", {
      message: { type: "tool-calls", toolCallList: [{ id, function: { name, arguments: JSON.stringify(args) } }] },
    }),
  );
  const data = await res.json();
  return data.results[0].result as string;
}

beforeEach(() => {
  resetRateLimits();
  resetCalendar();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
});
afterEach(() => vi.useRealTimers());

describe("voice webhook – createBooking (SEC-2)", () => {
  it("refuses an arbitrary slotTime instead of fabricating a slot", async () => {
    const r = await call("createBooking", { name: "Mallory", email: "m at example dot com", slotTime: "2099-01-01T00:00:00Z" });
    expect(r).toMatch(/bookable/i);
    expect(calendarState.insertCalls).toBe(0);
  });

  it("refuses weekend / 3 a.m. slots", async () => {
    for (const t of [istIso("2030-03-09", "10:00"), istIso("2030-03-05", "03:00")]) {
      await call("createBooking", { name: "Mallory", email: "m at example dot com", slotTime: t });
    }
    expect(calendarState.insertCalls).toBe(0);
  });

  it("books a slot exactly as listed by getAvailableSlots", async () => {
    const listing = await call("getAvailableSlots", {});
    const m = listing.match(/slotTime=(\S+)/);
    expect(m).toBeTruthy();
    const r = await call("createBooking", { name: "Alice Smith", email: "alice at example dot com", slotTime: m![1] });
    expect(r).toMatch(/Booked/);
    expect(calendarState.insertCalls).toBe(1);
    expect(calendarState.events[0].attendees).toContain("alice@example.com");
  });

  it("works out of order (createBooking without a prior getAvailableSlots)", async () => {
    const r = await call("createBooking", { name: "Bob Jones", email: "bob at example dot com", slotTime: istIso("2030-03-05", "11:00") });
    expect(r).toMatch(/Booked/);
  });

  it("reads an offset-less ISO time as IST, not UTC", async () => {
    const r = await call("createBooking", { name: "Bob Jones", email: "bob at example dot com", slotTime: "2030-03-05T10:00:00" });
    expect(r).toMatch(/Booked/);
    expect(calendarState.events[0].start).toBe("2030-03-05T04:30:00.000Z");
  });

  it("snaps ≤2 minute drift from the transcript to the half hour", async () => {
    await call("createBooking", { name: "Bob Jones", email: "bob at example dot com", slotTime: "2030-03-05T04:31:10.000Z" });
    expect(calendarState.events[0].start).toBe("2030-03-05T04:30:00.000Z");
  });

  it("asks the model to re-fetch when the time cannot be parsed", async () => {
    const r = await call("createBooking", { name: "Bob Jones", email: "bob at example dot com", slotTime: "tomorrow at ten" });
    expect(r).toMatch(/getAvailableSlots/);
    expect(calendarState.freebusyCalls + calendarState.insertCalls).toBe(0);
  });

  it("tells the model to offer new options when the slot was just taken", async () => {
    const t = istIso("2030-03-05", "11:00");
    calendarState.busy.push({ start: t, end: new Date(Date.parse(t) + 1_800_000).toISOString() });
    const r = await call("createBooking", { name: "Bob Jones", email: "bob at example dot com", slotTime: t });
    expect(r).toMatch(/taken/i);
    expect(r).toMatch(/getAvailableSlots/);
    expect(calendarState.insertCalls).toBe(0);
  });

  it("parallel tool calls for the same slot book it once", async () => {
    calendarState.latencyMs = 5;
    const t = istIso("2030-03-05", "12:00");
    const res = await POST(
      jsonReq("/api/vapi/webhook", {
        message: {
          type: "tool-calls",
          toolCallList: [
            { id: "a", function: { name: "createBooking", arguments: JSON.stringify({ name: "A One", email: "a at example dot com", slotTime: t }) } },
            { id: "b", function: { name: "createBooking", arguments: JSON.stringify({ name: "B Two", email: "b at example dot com", slotTime: t }) } },
          ],
        },
      }),
    );
    const { results } = await res.json();
    expect(results).toHaveLength(2);
    expect(calendarState.insertCalls).toBe(1);
  });

  it("reports missing parameters and unknown tools without touching the calendar", async () => {
    expect(await call("createBooking", { name: "x" })).toMatch(/Missing information/);
    expect(await call("dropTables", {})).toMatch(/Unknown tool/);
    expect(calendarState.insertCalls).toBe(0);
  });
});

describe("voice slot selection (BK-4)", () => {
  const mk = (date: string, hhmm: string) => toSlot(Date.parse(istIso(date, hhmm)));

  it("keeps 09:00–16:30 IST only, ≤4 per day, ≤3 days", () => {
    const days = ["2030-03-05", "2030-03-06", "2030-03-07", "2030-03-08"];
    const times = ["00:00", "08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "16:30", "17:00", "18:30"];
    const slots = days.flatMap((d) => times.map((t) => mk(d, t)));
    const out = selectVoiceSlots(slots);
    expect(out).toHaveLength(12);
    expect(new Set(out.map((s) => s.start.slice(0, 10))).size).toBeLessThanOrEqual(3);
    for (const s of out) {
      const h = new Date(Date.parse(s.start) + IST).getUTCHours();
      expect(h).toBeGreaterThanOrEqual(9);
      expect(h).toBeLessThan(17);
    }
  });

  it("midnight and early-morning IST slots are excluded (no '24:00' hour parsing)", () => {
    expect(selectVoiceSlots([mk("2030-03-05", "00:00"), mk("2030-03-05", "00:30")])).toEqual([]);
  });

  it("formats options with ordinals and IST times", () => {
    const text = formatSlotsForVoice([mk("2030-03-05", "09:00"), mk("2030-03-05", "09:30"), mk("2030-03-06", "14:00")]);
    expect(text).toContain("Option 1: Tuesday, March 5th at 9:00 AM");
    expect(text).toContain("Option 3: Wednesday, March 6th at 2:00 PM");
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd"]);
  });
});

describe("voice getAvailableSlots on calendar outage (BK-2)", () => {
  it("returns the fallback message, not 'no open slots'", async () => {
    calendarState.failFreebusy = true;
    const r = await call("getAvailableSlots", {});
    expect(r).toMatch(/trouble connecting/i);
    expect(r).not.toMatch(/no open slots/i);
  });
});
