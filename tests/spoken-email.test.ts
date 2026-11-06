import { describe, it, expect } from "vitest";
import { normalizeSpokenEmail as n } from "@/lib/spoken-email";

describe("normalizeSpokenEmail (BK-3)", () => {
  it.each([
    ["vinay chopra three sixty at gmail dot com", "vinaychopra360@gmail.com"],
    ["alice twenty one at example dot com", "alice21@example.com"],
    ["alice twenty at example dot com", "alice20@example.com"],
    ["john dot smith at gmail dot com", "john.smith@gmail.com"],
    ["bob underscore smith at x dot io", "bob_smith@x.io"],
    ["bob dash smith at x dot io", "bob-smith@x.io"],
    ["bob hyphen smith at x dot io", "bob-smith@x.io"],
    ["bob minus smith at x dot io", "bob-smith@x.io"], // was silently deleted before
    ["bob plus work at x dot io", "bob+work@x.io"],
    ["jo double zero seven at x dot com", "jo007@x.com"],
    ["tom triple w at x dot com", "tomwww@x.com"],
    ["nineteen ninety nine at x dot com", "1999@x.com"],
    ["one two three at x dot com", "123@x.com"],
    ["j o h n at x dot com", "john@x.com"],
    ["tony at the rate gmail dot com", "tony@gmail.com"],
    ["tony at the rate of gmail dot com", "tony@gmail.com"],
    ["Priya Sharma AT Gmail DOT com.", "priyasharma@gmail.com"],
    ["vinay dot 23bcs10174 at sst dot scaler dot com", "vinay.23bcs10174@sst.scaler.com"],
  ])("%s → %s", (spoken, expected) => {
    expect(n(spoken)).toBe(expected);
  });

  it("passes through an already-typed address, even with the word 'at' in it", () => {
    expect(n("a.b@gmail.com")).toBe("a.b@gmail.com");
    expect(n("matt at@gmail.com")).toBe("mattat@gmail.com");
  });

  it("returns null for things that cannot be an email", () => {
    for (const bad of ["", "   ", "hello world", "john at gmail", "at dot com", 42, null, undefined, "x".repeat(400)]) {
      expect(n(bad)).toBeNull();
    }
  });
});
