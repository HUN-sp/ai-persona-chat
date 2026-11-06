/** Abuse-protection limits. Env vars override the defaults without a redeploy of code. */

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const LIMITS = {
  /** Max request body for /api/chat, bytes. */
  get maxBodyBytes() { return num("MAX_BODY_BYTES", 256 * 1024); },
  /** Max messages accepted in one request (the UI keeps the whole chat). */
  maxMessages: 200,
  /** Messages actually forwarded to the LLM (most recent). */
  get historyForLlm() { return num("HISTORY_FOR_LLM", 16); },
  /** Max characters in a user message. */
  get maxUserChars() { return num("MAX_USER_CHARS", 1000); },
  /** Older assistant/user turns are truncated to this before going to the LLM. */
  maxHistoryChars: 4000,

  /** Per-IP request budgets (per serverless instance – see docs/OVERVIEW.md). */
  get chatPerMinute() { return num("RATE_CHAT_PER_MIN", 20); },
  get chatPerDay() { return num("RATE_CHAT_PER_DAY", 300); },
  get webhookPerMinute() { return num("RATE_WEBHOOK_PER_MIN", 120); },
  /** Global cap on calendar events created per hour (spam-invite protection). */
  get bookingsPerHour() { return num("MAX_BOOKINGS_PER_HOUR", 12); },
} as const;
