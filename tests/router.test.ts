import { describe, it, expect } from "vitest";
import { classifyIntent, isBookingIntent, isCancelIntent, isOffTopic } from "@/lib/router";
import { ROUTER_CASES } from "./fixtures/router-cases";

describe("classifyIntent – labelled set (RT-1, RT-2, RT-3)", () => {
  it.each(ROUTER_CASES)("%s  [%s] → %s", (msg, step, expected) => {
    expect(classifyIntent(msg, step)).toBe(expected);
  });

  it("reports aggregate accuracy and zero false positives on legitimate messages", () => {
    const wrong = ROUTER_CASES.filter(([m, s, e]) => classifyIntent(m, s) !== e);
    expect(wrong).toEqual([]);
  });
});

describe("router units", () => {
  it("booking words match whole words only", () => {
    for (const bad of ["facebook", "notebook", "bookmarks bar", "scheduler", "the Book-Author project"]) {
      expect(isBookingIntent(`tell me about ${bad}`)).toBe(false);
    }
    for (const good of ["book it", "booking", "any slots?", "schedule a meeting", "are you available"]) {
      expect(isBookingIntent(good)).toBe(true);
    }
  });

  it("emails are never read as intent words", () => {
    expect(isBookingIntent("bookworm@gmail.com")).toBe(false);
    expect(isCancelIntent("skipper@gmail.com", "awaiting_email")).toBe(false);
  });

  it("cancel only applies inside the booking flow", () => {
    expect(isCancelIntent("cancel", "idle")).toBe(false);
    expect(isCancelIntent("cancel", "day_shown")).toBe(true);
  });

  it("soft cancel phrases do not fire when a day/time is being discussed", () => {
    expect(isCancelIntent("I don't want Monday, Tuesday please", "day_shown")).toBe(false);
    expect(isCancelIntent("not now", "day_shown")).toBe(true);
  });

  it("off-topic needs a pattern AND no professional signal", () => {
    expect(isOffTopic("What is the capital of France?")).toBe(true);
    expect(isOffTopic("What is the capital of your stock market project?")).toBe(false);
    expect(isOffTopic("hello there")).toBe(false); // short → passes through
  });
});
