import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FIXED_NOW } from "./helpers/google-mock";

vi.mock("googleapis", async () => (await import("./helpers/google-mock")).googleModuleFactory());

import { handleBookingContinue, type BookingInput } from "@/lib/booking";
import { generateSlotGrid, toSlot, type Slot } from "@/lib/slots";

/** Free slots for the 2 weeks after FIXED_NOW (Mon 2030-03-04 08:30 IST). */
function allSlots(): Slot[] {
  const from = FIXED_NOW;
  return generateSlotGrid(from, new Date(from.getTime() + 14 * 86_400_000)).map((s) => toSlot(s.start.getTime()));
}
const dayOf = (s: Slot) => new Date(s.start).toISOString().slice(0, 10); // all slots fall on same UTC date as IST date (02:30–13:00Z)

function input(over: Partial<BookingInput> & { lastMsg: string; bookingStep: BookingInput["bookingStep"] }): BookingInput {
  const slots = allSlots();
  return { allSlots: slots, pendingSlots: slots, selectedSlot: null, slotPage: 0, ...over };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
});
afterEach(() => vi.useRealTimers());

describe("booking state machine (ported from verify-booking.ts)", () => {
  it("day_shown: 'Thursday 7 Mar' selects that date's slots", async () => {
    const r = await handleBookingContinue(input({ lastMsg: "Thursday 7 Mar", bookingStep: "day_shown" }));
    expect(r.type).toBe("response");
    if (r.type !== "response") return;
    expect(r.data.bookingStep).toBe("slots_shown");
    expect(r.data.pendingSlots!.every((s) => dayOf(s) === "2030-03-07")).toBe(true);
  });

  it("day_shown: compact date form 'Thursday 7Mar' also works", async () => {
    const r = await handleBookingContinue(input({ lastMsg: "Thursday 7Mar", bookingStep: "day_shown" }));
    expect(r.type === "response" && r.data.bookingStep).toBe("slots_shown");
  });

  it("day_shown: 'No Friday 8 Mar' is a correction, not a negation", async () => {
    const r = await handleBookingContinue(input({ lastMsg: "No Friday 8 Mar", bookingStep: "day_shown" }));
    expect(r.type).toBe("response");
    if (r.type !== "response") return;
    expect(r.data.bookingStep).toBe("slots_shown");
    expect(r.data.pendingSlots!.every((s) => dayOf(s) === "2030-03-08")).toBe(true);
  });

  it("day_shown: 'not Tuesday' excludes Tuesday from the day list", async () => {
    const r = await handleBookingContinue(input({ lastMsg: "not Tuesday", bookingStep: "day_shown" }));
    expect(r.type).toBe("response");
    if (r.type !== "response") return;
    expect(r.data.bookingStep).toBe("day_shown");
    expect(r.data.pendingSlots!.some((s) => dayOf(s) === "2030-03-05")).toBe(false);
    expect(r.data.pendingSlots!.some((s) => dayOf(s) === "2030-03-06")).toBe(true);
  });

  it("slots_shown: naming another day switches to that day's slots", async () => {
    const friday = allSlots().filter((s) => dayOf(s) === "2030-03-08");
    const r = await handleBookingContinue(input({ lastMsg: "Thursday 7 Mar", bookingStep: "slots_shown", pendingSlots: friday }));
    expect(r.type).toBe("response");
    if (r.type !== "response") return;
    expect(r.data.pendingSlots!.every((s) => dayOf(s) === "2030-03-07")).toBe(true);
  });

  it("slots_shown: '2 pm' selects the 14:00 IST slot and asks for name+email", async () => {
    const tue = allSlots().filter((s) => dayOf(s) === "2030-03-05");
    const r = await handleBookingContinue(input({ lastMsg: "2 pm", bookingStep: "slots_shown", pendingSlots: tue }));
    expect(r.type).toBe("response");
    if (r.type !== "response") return;
    expect(r.data.bookingStep).toBe("awaiting_email");
    expect(r.data.selectedSlot!.start).toBe("2030-03-05T08:30:00.000Z"); // 14:00 IST
  });

  it("slots_shown: unrelated question falls through (state preserved)", async () => {
    const tue = allSlots().filter((s) => dayOf(s) === "2030-03-05");
    const r = await handleBookingContinue(input({ lastMsg: "what is your tech stack?", bookingStep: "slots_shown", pendingSlots: tue }));
    expect(r.type).toBe("not_booking");
    if (r.type === "not_booking") expect(r.state.bookingStep).toBe("slots_shown");
  });
});
