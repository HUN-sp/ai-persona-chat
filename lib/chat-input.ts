import { LIMITS } from "./limits";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type ParsedMessages = { ok: true; messages: ChatMessage[]; lastMsg: string } | { ok: false; error: string };

/**
 * Validate the `messages` array from the browser.
 * - only `user` / `assistant` roles survive (a forged `system` turn is dropped)
 * - every content must be a string; the newest must be a user message ≤ maxUserChars
 * - older turns are truncated, and only the most recent `historyForLlm` are kept
 *   (bounds tokens/cost and limits fake-history injection)
 */
export function parseMessages(raw: unknown): ParsedMessages {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > LIMITS.maxMessages) {
    return { ok: false, error: "Invalid messages" };
  }
  const cleaned: ChatMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") return { ok: false, error: "Invalid messages" };
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (typeof content !== "string") return { ok: false, error: "Invalid messages" };
    if (role !== "user" && role !== "assistant") continue; // drop system/tool/unknown roles
    cleaned.push({ role, content });
  }
  const last = cleaned[cleaned.length - 1];
  if (!last || last.role !== "user") return { ok: false, error: "Invalid messages" };
  const lastMsg = last.content.trim();
  if (lastMsg.length === 0) return { ok: false, error: "Invalid messages" };
  if (lastMsg.length > LIMITS.maxUserChars) {
    return { ok: false, error: `Message too long (max ${LIMITS.maxUserChars} characters)` };
  }

  const recent = cleaned.slice(-LIMITS.historyForLlm).map((m, i, arr) => ({
    role: m.role,
    content: i === arr.length - 1 ? lastMsg : m.content.slice(0, LIMITS.maxHistoryChars),
  }));
  return { ok: true, messages: recent, lastMsg };
}
