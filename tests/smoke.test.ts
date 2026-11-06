import { describe, it, expect } from "vitest";
import { classifyIntent } from "@/lib/router";

describe("test harness", () => {
  it("resolves the @ alias and runs TS", () => {
    expect(classifyIntent("hello there friend", "idle")).toBe("chat");
  });
});
