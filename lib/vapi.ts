/**
 * Vapi tool-call handling, shared by /api/vapi/webhook and the /api/chat
 * compatibility alias (so there is exactly ONE authenticated code path).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { listFreeSlots, createBooking } from "./calendar";
import { retrieve } from "./retriever";
import { OWNER_EMAIL, OWNER_SHORT_NAME as OWNER } from "./config";
import { parseSlotTime, snapToGrid, toSlot } from "./slots";
import { normalizeSpokenEmail } from "./spoken-email";
import { selectVoiceSlots, formatSlotsForVoice } from "./voice";

// Spoken form of the owner's address, for the TTS voice.
const SPOKEN_OWNER_EMAIL = OWNER_EMAIL.replace(/@/g, " at ").replace(/\./g, " dot ");

const FALLBACK_MSG =
  `I'm having trouble connecting right now. Please ask the caller to email ${OWNER} directly at ${SPOKEN_OWNER_EMAIL}, or try again shortly.`;

const MAX_PARAM_CHARS = 2000;

// ── Authentication ──────────────────────────────────────────────

let warnedNoSecret = false;

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Verify the shared secret Vapi sends with every server message.
 * Configure the same value as VAPI_WEBHOOK_SECRET here and as the server
 * "secret" / bearer credential in the Vapi dashboard. Accepted headers:
 * `X-Vapi-Secret: <secret>` or `Authorization: Bearer <secret>`.
 *
 * If VAPI_WEBHOOK_SECRET is NOT set the request is allowed (so the live voice
 * agent keeps working) and a warning is logged once – set it as soon as possible.
 */
export function verifyVapiRequest(req: Request): boolean {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      console.warn("[vapi] VAPI_WEBHOOK_SECRET is not set: webhook is UNAUTHENTICATED. Set it in Vercel and in the Vapi dashboard.");
    }
    return true;
  }
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const provided = req.headers.get("x-vapi-secret") ?? bearer ?? "";
  return provided.length > 0 && safeEqual(provided, secret);
}

// ── Payload parsing ─────────────────────────────────────────────

/** True if a /api/chat body is actually a Vapi server message. */
export function isVapiPayload(body: unknown): boolean {
  const b = body as { message?: { type?: unknown; functionCall?: unknown }; functionCall?: unknown } | null;
  if (!b || typeof b !== "object") return false;
  const t = b.message?.type;
  return t === "tool-calls" || Boolean(b.message?.functionCall) || Boolean(b.functionCall) || (typeof t === "string" && t.startsWith("call-"));
}

export interface ToolCall {
  id: string;
  name: string;
  params: Record<string, string>;
}

function coerceParams(raw: unknown): Record<string, string> {
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw || "{}"); } catch { obj = {}; }
  }
  const out: Record<string, string> = {};
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v == null) continue;
      out[k] = String(v).slice(0, MAX_PARAM_CHARS);
    }
  }
  return out;
}

/** Accepts Vapi's `toolCallList`, OpenAI-style `toolCalls`, and `toolWithToolCallList`. */
export function extractToolCalls(message: unknown): ToolCall[] {
  const m = (message ?? {}) as Record<string, unknown>;
  const list =
    (Array.isArray(m.toolCallList) && m.toolCallList) ||
    (Array.isArray(m.toolCalls) && m.toolCalls) ||
    (Array.isArray(m.toolWithToolCallList) && (m.toolWithToolCallList as { toolCall?: unknown }[]).map((x) => x?.toolCall)) ||
    [];
  const calls: ToolCall[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    if (!raw || typeof raw !== "object") continue;
    const fn = (raw.function ?? {}) as Record<string, unknown>;
    const name = (fn.name ?? raw.name) as unknown;
    if (typeof name !== "string") continue;
    calls.push({
      id: String(raw.id ?? ""),
      name,
      params: coerceParams(fn.arguments ?? raw.arguments ?? raw.parameters),
    });
  }
  return calls;
}

// ── Tools ───────────────────────────────────────────────────────

export async function handleToolCall(name: string, parameters: Record<string, string>): Promise<string> {
  // ── searchVinayBackground — RAG over resume + GitHub ──
  if (name === "searchVinayBackground") {
    const query = (parameters?.query ?? "").slice(0, 500);
    if (!query) return `Please ask a specific question about ${OWNER}.`;
    try {
      const context = await retrieve(query, 5);
      return context
        ? context
        : `I don't have specific information about that. You can email ${OWNER} at ${SPOKEN_OWNER_EMAIL} for more details.`;
    } catch (e) {
      console.error("searchVinayBackground error:", e instanceof Error ? e.message : "unknown");
      return FALLBACK_MSG;
    }
  }

  // ── getAvailableSlots ──
  if (name === "getAvailableSlots") {
    try {
      const allSlots = await listFreeSlots(); // throws if the calendar is unreadable → FALLBACK_MSG, never "no slots"
      const voiceSlots = selectVoiceSlots(allSlots);

      if (voiceSlots.length === 0) {
        return `${OWNER} has no open slots in the 9 AM to 5 PM window in the next 2 weeks. Ask the caller to email ${OWNER} at ${SPOKEN_OWNER_EMAIL} to arrange a custom time.`;
      }

      const slotList = formatSlotsForVoice(voiceSlots);
      return `Here are ${OWNER}'s available slots:\n${slotList}\n\nRead each option aloud (skip the slotTime value). Ask which option they want. Then ask for their name and email. Then call createBooking with the slotTime of their chosen option.`;
    } catch (e) {
      console.error("getAvailableSlots error:", e instanceof Error ? e.message : "unknown");
      return FALLBACK_MSG;
    }
  }

  // ── createBooking ──
  if (name === "createBooking") {
    const { name: callerName, email: rawEmail, slotTime } = parameters ?? {};
    if (!callerName || !rawEmail || !slotTime) {
      return "Missing information — I need the caller's full name, email address, and chosen slot time to complete the booking.";
    }

    // "vinay chopra three sixty at gmail dot com" → vinaychopra360@gmail.com
    const email = normalizeSpokenEmail(rawEmail);
    if (!email) {
      return (
        `The email address wasn't captured correctly — the transcription may have garbled it. ` +
        `Ask the caller to say their email in this format: username, then "at", then domain. ` +
        `For example: "john dot smith at gmail dot com". Do not ask them to spell it letter by letter.`
      );
    }

    // The slot must come back exactly as listed by getAvailableSlots (ISO string).
    // Offset-less times are read as IST; ≤2 min drift is snapped to the half hour.
    const parsed = parseSlotTime(slotTime);
    if (parsed === null) {
      return "I couldn't read that slot time. Call getAvailableSlots again and pass the slotTime value of the chosen option exactly as listed.";
    }

    try {
      const result = await createBooking(callerName, email, toSlot(snapToGrid(parsed)));
      console.log(`[vapi] booking result: ${result.code}`);
      if (result.success) return result.message;
      if (result.code === "slot_taken" || result.code === "invalid_slot") {
        return `${result.message} Tell the caller, then call getAvailableSlots again and offer the new options.`;
      }
      return result.message;
    } catch (e) {
      console.error("createBooking error:", e instanceof Error ? e.message : "unknown");
      return FALLBACK_MSG;
    }
  }

  return "Unknown tool — please only call searchVinayBackground, getAvailableSlots, or createBooking.";
}

/** Process a (verified) Vapi server message and return the JSON the webhook should send back. */
export async function handleVapiBody(body: unknown): Promise<Record<string, unknown>> {
  const b = (body ?? {}) as { message?: { type?: string; functionCall?: { name?: string; parameters?: unknown } }; functionCall?: { name?: string; parameters?: unknown } };
  const msgType = b.message?.type;

  // Newer format: tool-calls
  if (msgType === "tool-calls") {
    const calls = extractToolCalls(b.message);
    console.log(`[vapi] tool-calls: ${calls.map((c) => c.name).join(",") || "(none)"}`);
    const results = await Promise.all(
      calls.map(async (c) => ({ toolCallId: c.id, result: await handleToolCall(c.name, c.params) })),
    );
    return { results };
  }

  // Older format: function-call / functionCall
  const functionCall = b.message?.functionCall ?? b.functionCall;
  if (functionCall && typeof functionCall.name === "string") {
    const result = await handleToolCall(functionCall.name, coerceParams(functionCall.parameters));
    return { result };
  }

  // Other event types (call-start, call-end, …) — just acknowledge
  return { result: "ok" };
}
