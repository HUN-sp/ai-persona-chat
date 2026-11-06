import { describe, it, expect } from "vitest";
import { TtlCache } from "@/lib/cache";

describe("TtlCache", () => {
  it("expires entries", () => {
    const c = new TtlCache<number>(10, 1000);
    c.set("a", 1, 0);
    expect(c.get("a", 999)).toBe(1);
    expect(c.get("a", 1000)).toBeUndefined();
  });
  it("evicts the least recently used beyond max size", () => {
    const c = new TtlCache<number>(2, 1000);
    c.set("a", 1, 0);
    c.set("b", 2, 0);
    c.get("a", 1); // a is now most recent
    c.set("c", 3, 2);
    expect(c.get("b", 3)).toBeUndefined();
    expect(c.get("a", 3)).toBe(1);
    expect(c.size).toBe(2);
  });
});
