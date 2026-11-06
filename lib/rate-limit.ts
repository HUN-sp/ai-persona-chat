/**
 * Sliding-window rate limiter, in memory.
 *
 * LIMITATION: state is per server instance. On serverless (Vercel) each warm
 * instance has its own counters, so this blunts casual abuse and runaway
 * loops but is not a hard global cap. For a hard cap, back it with a shared
 * store (Upstash Redis / Vercel KV) – see docs/AUDIT.md OPS-1.
 */

const buckets = new Map<string, number[]>();
let lastSweep = 0;

export interface RateResult {
  ok: boolean;
  retryAfterSec: number;
}

export function rateLimit(key: string, limit: number, windowMs: number, now: number = Date.now()): RateResult {
  sweep(now, windowMs);
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000)) };
  }
  hits.push(now);
  buckets.set(key, hits);
  return { ok: true, retryAfterSec: 0 };
}

/** Drop empty/stale buckets now and then so the Map can't grow without bound. */
function sweep(now: number, windowMs: number) {
  if (now - lastSweep < 60_000 && buckets.size < 5000) return;
  lastSweep = now;
  const horizon = Math.max(windowMs, 24 * 60 * 60_000);
  for (const [k, hits] of buckets) {
    if (hits.length === 0 || now - hits[hits.length - 1] > horizon) buckets.delete(k);
  }
}

export function resetRateLimits() {
  buckets.clear();
  lastSweep = 0;
}
