/**
 * Chat API route — thin HTTP orchestrator.
 *
 * Routing is deterministic (zero LLM calls for intent classification).
 * Only the final response generation uses an LLM (Groq).
 *
 * Flow:
 *   1. Rate-limit, read + size-cap the body
 *   2. Vapi-compat alias (authenticated) → shared handler
 *   3. Validate messages; rebuild the (untrusted) booking state
 *   4. classifyIntent() → cancel | booking_start | booking_continue | off_topic | chat
 *   5. Dispatch to the appropriate handler, return JSON
 */

import { classifyIntent, isOffTopic } from "@/lib/router";
import { handleCancel, handleBookingStart, handleBookingContinue, getBookingReminder } from "@/lib/booking";
import { sanitizeBookingState } from "@/lib/booking-state";
import { parseMessages } from "@/lib/chat-input";
import { generateRagAnswer } from "@/lib/chat";
import { MAX_TOKENS_MIDFLOW, idleState } from "@/lib/config";
import type { ChatResponse } from "@/lib/config";
import { clientIp, json, preflight, readJson } from "@/lib/http";
import { LIMITS } from "@/lib/limits";
import { rateLimit } from "@/lib/rate-limit";
import { handleVapiBody, isVapiPayload, verifyVapiRequest } from "@/lib/vapi";

function tooMany(req: Request, retryAfterSec: number) {
  return json(
    req,
    { error: "You're sending messages too quickly. Please wait a moment and try again." },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

export async function POST(req: Request) {
  try {
    const parsedBody = await readJson(req);
    if (!parsedBody.ok) return json(req, { error: parsedBody.error }, { status: parsedBody.status });
    const body = parsedBody.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json(req, { error: "Invalid request" }, { status: 400 });
    }
    const ip = clientIp(req);

    // ── Vapi alias: some assistants point their Server URL at /api/chat ──
    if (isVapiPayload(body)) {
      if (!verifyVapiRequest(req)) return json(req, { error: "Unauthorized" }, { status: 401 });
      const rl = rateLimit(`webhook:${ip}`, LIMITS.webhookPerMinute, 60_000);
      if (!rl.ok) return tooMany(req, rl.retryAfterSec);
      return json(req, await handleVapiBody(body));
    }

    // ── Abuse limits (per IP, per serverless instance) ──
    const perMin = rateLimit(`chat:min:${ip}`, LIMITS.chatPerMinute, 60_000);
    if (!perMin.ok) return tooMany(req, perMin.retryAfterSec);
    const perDay = rateLimit(`chat:day:${ip}`, LIMITS.chatPerDay, 86_400_000);
    if (!perDay.ok) return tooMany(req, perDay.retryAfterSec);

    const parsed = parseMessages((body as { messages?: unknown }).messages);
    if (!parsed.ok) return json(req, { error: parsed.error }, { status: 400 });
    const { messages, lastMsg } = parsed;

    // Booking state comes from the browser and is untrusted: rebuild it.
    const state = sanitizeBookingState(body);

    // ── Deterministic intent classification ──
    const intent = classifyIntent(lastMsg, state.bookingStep);

    switch (intent) {
      // ── CANCEL: exit booking flow ──
      case "cancel":
        return json(req, handleCancel());

      // ── BOOKING START: fetch slots and begin flow ──
      case "booking_start":
        return json(req, await handleBookingStart());

      // ── BOOKING CONTINUE: advance the state machine ──
      case "booking_continue": {
        const result = await handleBookingContinue({ lastMsg, ...state });

        // Booking action was handled → return directly
        if (result.type === "response") return json(req, result.data);

        // Message wasn't booking-related → answer via RAG, preserve booking state
        const kept = result.state;

        // Off-topic during booking → deflect + remind about booking
        if (isOffTopic(lastMsg)) {
          return json(req, {
            reply:
              "That's outside my scope — I'm focused on my professional background.\n\n---\n" +
              getBookingReminder(kept),
            ...kept,
          } satisfies ChatResponse);
        }

        // On-topic question during booking → RAG answer + booking reminder
        const answer = await generateRagAnswer(messages, lastMsg, MAX_TOKENS_MIDFLOW);
        return json(req, { reply: `${answer}\n\n---\n${getBookingReminder(kept)}`, ...kept } satisfies ChatResponse);
      }

      // ── OFF-TOPIC: warm deflection ──
      case "off_topic":
        return json(req, {
          reply: "That's a bit outside my lane — I'm Vinay's professional AI representative, so I'm focused on his background, technical work, and availability. What would you like to know about my work?",
          ...idleState(),
        } satisfies ChatResponse);

      // ── CHAT: RAG-grounded conversation (default) ──
      case "chat":
        return json(req, { reply: await generateRagAnswer(messages, lastMsg), ...idleState() } satisfies ChatResponse);
    }
  } catch (error) {
    // Log the message only (no request body → no PII); never echo internals to the client.
    console.error("Chat API error:", error instanceof Error ? error.message : "unknown");
    return json(req, { error: "Something went wrong on my side. Please try again in a moment." }, { status: 500 });
  }
}

export function OPTIONS(req: Request) {
  return preflight(req);
}
