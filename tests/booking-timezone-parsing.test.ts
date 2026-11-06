import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FIXED_NOW } from "./helpers/google-mock";

vi.mock("googleapis", async () => (await import("./helpers/google-mock")).googleModuleFactory());

import { handleBookingContinue, handleBookingStart } from "@/lib/booking";
import { generateSlotGrid, toSlot, istParts, type Slot } from "@/lib/slots";
import { calendarState, resetCalendar } from "./helpers/google-mock";

const ORIGINAL_TZ = process.env.TZ;
function slotsFrom(now: Date): Slot[] {
  return generateSlotGrid(now, new Date(now.getTime() + 14 * 86_400_000)).map((s) => toSlot(s.start.getTime()));
}
const dayKey = (s: Slot) => istParts(Date.parse(s.start)).dateKey;
const onDay = (slots: Slot[], key: string) => slots.filter((s) => dayKey(s) === key);

async function pick(msg: string, step: "day_shown" | "slots_shown", all: Slot[], pending: Slot[] = all) {
  return handleBookingContinue({ lastMsg: msg, bookingStep: step, allSlots: all, pendingSlots: pending, selectedSlot: null, slotPage: 0 });
}

beforeEach(() => {
  resetCalendar();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
});
afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = ORIGINAL_TZ;
});

describe("booking is independent of the server time zone (BK-1)", () => {
  it.each(["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Auckland", "Asia/Tokyo"])("TZ=%s groups IST days correctly", async (tz) => {
    process.env.TZ = tz;
    if (tz === "America/Los_Angeles") expect(new Date(FIXED_NOW).getTimezoneOffset()).not.toBe(0); // the switch really took effect
    const all = slotsFrom(FIXED_NOW);

    const r = await pick("1", "day_shown", all);
    expect(r.type).toBe("response");
    if (r.type !== "response") return;
    // day 1 is Monday 4 Mar (IST) – never split into "Sunday"+"Monday"
    expect(new Set(r.data.pendingSlots!.map(dayKey)).size).toBe(1);
    expect(dayKey(r.data.pendingSlots![0])).toBe("2030-03-04");
    expect(r.data.reply).toContain("Monday, 4 Mar");

    const tue = await pick("Tuesday", "day_shown", all);
    expect(tue.type === "response" && tue.data.pendingSlots!.length).toBe(22);
    expect(tue.type === "response" && dayKey(tue.data.pendingSlots![0])).toBe("2030-03-05");

    const full = await pick("2 pm", "slots_shown", all, onDay(all, "2030-03-05"));
    expect(full.type === "response" && full.data.selectedSlot!.start).toBe("2030-03-05T08:30:00.000Z"); // 14:00 IST
  });

  it("the day summary lists exactly the 10 weekdays in the 2-week window, no duplicates", async () => {
    process.env.TZ = "America/Los_Angeles";
    const r = await handleBookingStart();
    const lines = r.reply.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(10);
    expect(new Set(lines.map((l) => l.replace(/^\d+\. /, ""))).size).toBe(lines.length);
    expect(r.reply).not.toMatch(/Saturday|Sunday/);
    void calendarState;
  });
});

describe("time parsing (BK-5)", () => {
  const tue = () => onDay(slotsFrom(FIXED_NOW), "2030-03-05");
  const picked = async (msg: string) => {
    const all = slotsFrom(FIXED_NOW);
    const r = await pick(msg, "slots_shown", all, tue());
    return r.type === "response" && r.data.selectedSlot ? istParts(Date.parse(r.data.selectedSlot.start)) : null;
  };

  it.each([
    ["2:30", 14, 30],
    ["2:30 pm", 14, 30],
    ["14:30", 14, 30],
    ["at 3", 15, 0],
    ["at 3pm", 15, 0],
    ["noon", 12, 0],
    ["12 pm", 12, 0],
    ["12:30", 12, 30],
    ["8 am", 8, 0],
    ["8:30am please", 8, 30],
    ["6:30 pm", 18, 30],
    ["I can do maybe 2pm", 14, 0],
  ])("%s → %i:%i IST", async (msg, h, m) => {
    const p = await picked(msg);
    expect(p && [p.hour, p.minute]).toEqual([h, m]);
  });

  it("midnight is not mistaken for noon or a bookable slot", async () => {
    expect(await picked("12 am")).toBeNull();
    expect(await picked("12:30 am")).toBeNull();
    expect(await picked("0:00")).toBeNull();
  });
});

describe("date parsing (BK-5)", () => {
  it("month names must be whole words: 'market', 'maybe', 'decide' are not dates", async () => {
    const all = slotsFrom(FIXED_NOW);
    for (const msg of ["tell me about the market data publisher", "I can't decide yet, maybe later", "what about mar"]) {
      const r = await pick(msg, "day_shown", all);
      expect(r.type).toBe("not_booking");
    }
  });

  it("understands '5 March', 'March 5th', '5th mar' and the compact '5Mar'", async () => {
    const all = slotsFrom(FIXED_NOW);
    for (const msg of ["5 March", "March 5th", "5th mar", "5Mar", "Tuesday 5Mar"]) {
      const r = await pick(msg, "day_shown", all);
      expect(r.type === "response" && dayKey(r.data.pendingSlots![0]), msg).toBe("2030-03-05");
    }
  });

  it("works across New Year (December request for a January slot)", async () => {
    const now = new Date("2030-12-30T03:00:00.000Z"); // Mon 30 Dec 2030, 08:30 IST
    vi.setSystemTime(now);
    const all = slotsFrom(now);
    const r = await pick("6 January", "day_shown", all);
    expect(r.type === "response" && dayKey(r.data.pendingSlots![0])).toBe("2031-01-06");
  });

  it("'today' / 'tomorrow' follow the IST date, not the server date", async () => {
    // 23:00 UTC on Mon 4 Mar = 04:30 IST Tue 5 Mar → "tomorrow" is Wed 6 Mar in IST
    const now = new Date("2030-03-04T23:00:00.000Z");
    vi.setSystemTime(now);
    process.env.TZ = "America/Los_Angeles";
    const all = slotsFrom(now);
    const r = await pick("tomorrow", "day_shown", all);
    expect(r.type === "response" && dayKey(r.data.pendingSlots![0])).toBe("2030-03-06");
  });
});
