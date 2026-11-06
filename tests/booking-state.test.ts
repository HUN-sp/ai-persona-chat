import { describe, it, expect } from "vitest";
import { sanitizeBookingState } from "@/lib/booking-state";
import { FIXED_NOW } from "./helpers/google-mock";

const NOW = FIXED_NOW.getTime();
const IST = 330 * 60_000;
const at = (date: string, hhmm: string) => {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, h, mi) - IST);
  return { start: start.toISOString(), end: new Date(start.getTime() + 1_800_000).toISOString() };
};

describe("sanitizeBookingState (untrusted client state)", () => {
  it("collapses garbage to idle", () => {
    for (const bad of [null, undefined, 5, "x", [], {}, { bookingStep: "hacked" }]) {
      expect(sanitizeBookingState(bad, NOW).bookingStep).toBe("idle");
    }
  });

  it("awaiting_email without a valid selectedSlot becomes idle", () => {
    expect(sanitizeBookingState({ bookingStep: "awaiting_email", selectedSlot: null }, NOW).bookingStep).toBe("idle");
    const evil = { start: "2099-01-01T00:00:00.000Z", end: "2099-01-02T00:00:00.000Z" };
    expect(sanitizeBookingState({ bookingStep: "awaiting_email", selectedSlot: evil }, NOW).bookingStep).toBe("idle");
  });

  it("keeps a valid slot but rewrites a forged end", () => {
    const good = at("2030-03-05", "10:00");
    const s = sanitizeBookingState({ bookingStep: "awaiting_email", selectedSlot: { start: good.start, end: "2031-01-01T00:00:00Z" } }, NOW);
    expect(s.bookingStep).toBe("awaiting_email");
    expect(s.selectedSlot).toEqual(good);
  });

  it("drops invalid and duplicate slots from lists", () => {
    const a = at("2030-03-05", "10:00");
    const b = at("2030-03-05", "10:30");
    const weekend = at("2030-03-09", "10:00");
    const s = sanitizeBookingState(
      { bookingStep: "day_shown", allSlots: [a, a, weekend, { start: 7 }, null, b], pendingSlots: [weekend, a] },
      NOW,
    );
    expect(s.allSlots).toEqual([a, b]);
    expect(s.pendingSlots).toEqual([a]);
  });

  it("day_shown / slots_shown with nothing valid to pick from becomes idle", () => {
    const weekend = at("2030-03-09", "10:00");
    expect(sanitizeBookingState({ bookingStep: "day_shown", pendingSlots: [weekend] }, NOW).bookingStep).toBe("idle");
    expect(sanitizeBookingState({ bookingStep: "slots_shown", pendingSlots: "nope" }, NOW).bookingStep).toBe("idle");
  });

  it("caps oversized arrays", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ start: new Date(NOW + 3_600_000 + i * 1_800_000).toISOString() }));
    const s = sanitizeBookingState({ bookingStep: "day_shown", pendingSlots: many }, NOW);
    expect((s.pendingSlots ?? []).length).toBeLessThanOrEqual(300);
  });
});
