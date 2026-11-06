/** Tiny in-memory TTL + LRU cache (per server instance; safe to lose). */
export class TtlCache<V> {
  private store = new Map<string, { value: V; expires: number }>();
  constructor(private maxEntries = 200, private ttlMs = 30 * 60_000) {}

  get(key: string, now: number = Date.now()): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires <= now) {
      this.store.delete(key);
      return undefined;
    }
    // refresh recency
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, now: number = Date.now()): void {
    this.store.delete(key);
    this.store.set(key, { value, expires: now + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  clear(): void {
    this.store.clear();
  }
  get size(): number {
    return this.store.size;
  }
}
