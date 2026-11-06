import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { calendarState, resetCalendar, FIXED_NOW } from "./helpers/google-mock";
import { resetRateLimits } from "@/lib/rate-limit";
import { jsonReq, groqCreate, groqModuleFactory } from "./helpers/route";

vi.mock("googleapis", async () => (await import("./helpers/google-mock")).googleModuleFactory());
vi.mock("groq-sdk", () => groqModuleFactory());
vi.mock("@/lib/retriever", () => ({ retrieve: vi.fn(async () => "CTX") }));

import { POST } from "@/app/api/chat/route";

const IST = 330 * 60_000;
const at = (date: string, hhmm: string) => {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, h, mi) - IST);
  return { start: start.toISOString(), end: new Date(start.getTime() + 1_800_000).toISOString() };
};

beforeEach(() => {
  resetRateLimits();
  resetCalendar();
  groqCreate.mockResolvedValue({ choices: [{ message: { content: "LLM-REPLY" } }] });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
});
afterEach(() => vi.useRealTimers());

describe("POST /api/chat – tampered booking state (SEC-1)", () => {
  it("does NOT book an arbitrary far-future slot supplied by the client", async () => {
    const res = await POST(
      jsonReq("/api/chat", {
        messages: [{ role: "user", content: "alice@example.com" }],
        bookingStep: "awaiting_email",
        selectedSlot: { start: "2099-01-01T00:00:00.000Z", end: "2099-01-02T00:00:00.000Z" },
      }),
    );
    const data = await res.json();
    expect(calendarState.insertCalls).toBe(0);
    expect(data.reply).not.toMatch(/Booked/);
    expect(data.bookingStep).toBe("idle");
  });

  it("does NOT book a busy slot even if the client claims it was offered", async () => {
    const s = at("2030-03-05", "10:00");
    calendarState.busy.push(s);
    const res = await POST(
      jsonReq("/api/chat", {
        messages: [{ role: "user", content: "Alice Smith alice@example.com" }],
        bookingStep: "awaiting_email",
        allSlots: [s],
        pendingSlots: [s],
        selectedSlot: s,
      }),
    );
    const data = await res.json();
    expect(calendarState.insertCalls).toBe(0);
    expect(data.reply).toMatch(/just taken/i);
    // user is shown fresh availability instead of being stuck
    expect(data.bookingStep).toBe("day_shown");
    expect(data.allSlots.some((x: { start: string }) => x.start === s.start)).toBe(false);
  });

  it("books a legitimately selected, free slot exactly once with a 30-minute event", async () => {
    const s = at("2030-03-05", "10:00");
    const res = await POST(
      jsonReq("/api/chat", {
        messages: [{ role: "user", content: "Alice Smith alice@example.com" }],
        bookingStep: "awaiting_email",
        allSlots: [s],
        pendingSlots: [s],
        selectedSlot: { start: s.start, end: "2031-01-01T00:00:00Z" },
      }),
    );
    const data = await res.json();
    expect(data.reply).toMatch(/Booked/);
    expect(data.bookingStep).toBe("idle");
    expect(calendarState.insertCalls).toBe(1);
    expect(calendarState.events[0].attendees).toContain("alice@example.com");
    expect(Date.parse(calendarState.events[0].end) - Date.parse(calendarState.events[0].start)).toBe(1_800_000);
  });

  it("full happy path through the state machine: start → day → time → email", async () => {
    let state: Record<string, unknown> = {};
    const send = async (content: string) => {
      const res = await POST(jsonReq("/api/chat", { messages: [{ role: "user", content }], ...state }));
      const d = await res.json();
      state = { bookingStep: d.bookingStep, allSlots: d.allSlots, pendingSlots: d.pendingSlots, selectedSlot: d.selectedSlot, slotPage: d.slotPage };
      return d;
    };
    const a = await send("I'd like to book a call with Vinay");
    expect(a.bookingStep).toBe("day_shown");
    const b = await send("1");
    expect(b.bookingStep).toBe("slots_shown");
    const c = await send("1");
    expect(c.bookingStep).toBe("awaiting_email");
    expect(c.selectedSlot).toBeTruthy();
    const d = await send("Alice Smith, alice@example.com");
    expect(d.reply).toMatch(/Booked/);
    expect(calendarState.insertCalls).toBe(1);
  });

  it("never lets the LLM path create bookings", async () => {
    const res = await POST(jsonReq("/api/chat", { messages: [{ role: "user", content: "Tell me about your Product Service" }] }));
    const data = await res.json();
    expect(data.reply).toBe("LLM-REPLY");
    expect(calendarState.insertCalls).toBe(0);
  });
});
