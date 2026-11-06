import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { calendarState, resetCalendar, FIXED_NOW } from "./helpers/google-mock";

vi.mock("googleapis", async () => (await import("./helpers/google-mock")).googleModuleFactory());

import { createBooking } from "@/lib/calendar";
import { generateSlotGrid, isValidSlotStart, parseSlotTime, snapToGrid } from "@/lib/slots";

const IST = 330 * 60_000;
/** ISO (UTC) for an IST wall-clock time on a given IST date. */
function ist(date: string, hhmm: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, mi) - IST).toISOString();
}
const slotAt = (date: string, hhmm: string) => {
  const start = ist(date, hhmm);
  return { start, end: new Date(Date.parse(start) + 30 * 60_000).toISOString() };
};

beforeEach(() => {
  resetCalendar();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
  process.env.GOOGLE_CLIENT_ID = "x";
  process.env.GOOGLE_CLIENT_SECRET = "x";
  process.env.GOOGLE_REFRESH_TOKEN = "x";
});
afterEach(() => vi.useRealTimers());

describe("slot grid", () => {
  it("accepts a normal future weekday slot", () => {
    expect(isValidSlotStart(Date.parse(ist("2030-03-05", "10:00")), FIXED_NOW.getTime())).toBe(true);
    expect(isValidSlotStart(Date.parse(ist("2030-03-05", "18:30")), FIXED_NOW.getTime())).toBe(true);
    expect(isValidSlotStart(Date.parse(ist("2030-03-05", "08:00")), FIXED_NOW.getTime())).toBe(true);
  });

  it.each([
    ["weekend (Sat)", "2030-03-09", "10:00"],
    ["weekend (Sun)", "2030-03-10", "10:00"],
    ["before hours", "2030-03-05", "07:30"],
    ["after hours", "2030-03-05", "19:00"],
    ["midnight", "2030-03-05", "00:00"],
    ["off-grid minute", "2030-03-05", "10:15"],
    ["in the past", "2030-03-04", "08:00"],
    ["beyond 14-day horizon", "2030-03-25", "10:00"],
  ])("rejects %s", (_n, d, t) => {
    expect(isValidSlotStart(Date.parse(ist(d, t)), FIXED_NOW.getTime())).toBe(false);
  });

  it("rejects NaN / non-finite", () => {
    expect(isValidSlotStart(NaN, FIXED_NOW.getTime())).toBe(false);
    expect(isValidSlotStart(Infinity, FIXED_NOW.getTime())).toBe(false);
  });

  it("every generated slot passes validation and there are 22 per weekday", () => {
    const now = FIXED_NOW.getTime();
    const grid = generateSlotGrid(new Date(now), new Date(now + 14 * 86_400_000));
    expect(grid.length).toBeGreaterThan(100);
    for (const s of grid) expect(isValidSlotStart(s.start.getTime(), now)).toBe(true);
    const tue = grid.filter((s) => s.start.toISOString().startsWith("2030-03-05"));
    expect(tue.length).toBe(22);
  });

  it("parseSlotTime treats offset-less ISO as IST and keeps explicit offsets", () => {
    expect(parseSlotTime("2030-03-05T10:00:00")).toBe(Date.parse("2030-03-05T10:00:00+05:30"));
    expect(parseSlotTime("2030-03-05T10:00:00+05:30")).toBe(Date.parse("2030-03-05T04:30:00Z"));
    expect(parseSlotTime("2030-03-05T04:30:00.000Z")).toBe(Date.parse("2030-03-05T04:30:00Z"));
    expect(parseSlotTime("tomorrow at 10")).toBeNull();
    expect(parseSlotTime("")).toBeNull();
  });

  it("snapToGrid tolerates ≤2 min drift only", () => {
    const base = Date.parse("2030-03-05T04:30:00Z");
    expect(snapToGrid(base + 90_000)).toBe(base);
    expect(snapToGrid(base - 60_000)).toBe(base);
    expect(snapToGrid(base + 10 * 60_000)).toBe(base + 10 * 60_000);
  });
});

describe("createBooking server-side guard (SEC-1, SEC-2, SEC-3)", () => {
  it("refuses an arbitrary far-future multi-hour slot and never calls insert", async () => {
    const evil = { start: "2099-01-01T00:00:00.000Z", end: "2099-01-02T00:00:00.000Z" };
    const r = await createBooking("Mallory", "m@example.com", evil);
    expect(r.success).toBe(false);
    expect(r.code).toBe("invalid_slot");
    expect(calendarState.insertCalls).toBe(0);
  });

  it("refuses weekend and out-of-hours slots", async () => {
    for (const [d, t] of [["2030-03-09", "10:00"], ["2030-03-05", "03:00"]]) {
      const r = await createBooking("A B", "a@example.com", slotAt(d, t));
      expect(r.code).toBe("invalid_slot");
    }
    expect(calendarState.insertCalls).toBe(0);
  });

  it("ignores a client-supplied `end` and always books exactly 30 minutes", async () => {
    const good = slotAt("2030-03-05", "10:00");
    const r = await createBooking("Alice Smith", "alice@example.com", { start: good.start, end: "2030-03-20T00:00:00.000Z" });
    expect(r.success).toBe(true);
    expect(calendarState.events).toHaveLength(1);
    expect(Date.parse(calendarState.events[0].end) - Date.parse(calendarState.events[0].start)).toBe(30 * 60_000);
  });

  it("re-checks freebusy and refuses a slot that became busy", async () => {
    const s = slotAt("2030-03-05", "10:00");
    calendarState.busy.push({ start: s.start, end: s.end }); // someone else took it after the list was shown
    const r = await createBooking("Alice Smith", "alice@example.com", s);
    expect(r.success).toBe(false);
    expect(r.code).toBe("slot_taken");
    expect(calendarState.insertCalls).toBe(0);
  });

  it("serialises concurrent bookings of the same slot: exactly one wins (chat vs voice race)", async () => {
    calendarState.latencyMs = 5;
    const s = slotAt("2030-03-05", "11:00");
    const results = await Promise.all([
      createBooking("Chat User", "chat@example.com", s),
      createBooking("Voice User", "voice@example.com", s),
      createBooking("Third User", "third@example.com", s),
    ]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.filter((r) => r.code === "slot_taken")).toHaveLength(2);
    expect(calendarState.insertCalls).toBe(1);
  });

  it("different slots can still be booked concurrently", async () => {
    calendarState.latencyMs = 5;
    const [a, b] = await Promise.all([
      createBooking("A One", "a@example.com", slotAt("2030-03-05", "11:00")),
      createBooking("B Two", "b@example.com", slotAt("2030-03-05", "11:30")),
    ]);
    expect(a.success && b.success).toBe(true);
  });

  it("fails closed when freebusy cannot be read (no blind insert)", async () => {
    calendarState.failFreebusy = true;
    const r = await createBooking("Alice Smith", "alice@example.com", slotAt("2030-03-05", "10:00"));
    expect(r.code).toBe("calendar_error");
    expect(calendarState.insertCalls).toBe(0);
  });

  it("does not leak raw calendar errors to the caller", async () => {
    calendarState.failInsert = true;
    const r = await createBooking("Alice Smith", "alice@example.com", slotAt("2030-03-05", "10:00"));
    expect(r.success).toBe(false);
    expect(r.message).not.toContain("secret-internal-detail");
  });

  it("rejects invalid email / oversized name before touching the calendar", async () => {
    const s = slotAt("2030-03-05", "10:00");
    expect((await createBooking("Al", "not-an-email", s)).code).toBe("invalid_input");
    expect((await createBooking("Al", "a@b.c\nbcc:evil@x.com", s)).code).toBe("invalid_input");
    expect(calendarState.freebusyCalls).toBe(0);
    const r = await createBooking("N".repeat(500), "ok@example.com", s);
    expect(r.success).toBe(true);
    expect((calendarState.events[0].summary ?? "").length).toBeLessThan(120);
  });
});
