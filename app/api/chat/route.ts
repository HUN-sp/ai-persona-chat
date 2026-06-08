/**
 * Chat API route — thin orchestrator.
 *
 * Routing is deterministic (zero LLM calls for intent classification).
 * Only the final response generation uses an LLM (Groq).
 *
 * Flow:
 *   1. Parse + validate request
 *   2. classifyIntent() → cancel | booking_start | booking_continue | off_topic | chat
 *   3. Dispatch to the appropriate handler
 *   4. Return JSON response
 */

import Groq from "groq-sdk";
import { retrieve } from "@/lib/retriever";
import { classifyIntent, isOffTopic } from "@/lib/router";
import {
  handleCancel,
  handleBookingStart,
  handleBookingContinue,
  getBookingReminder,
} from "@/lib/booking";
import { SYSTEM_PROMPT } from "@/lib/persona";
import {
  GROQ_MODEL,
  MAX_TOKENS_CHAT,
  MAX_TOKENS_MIDFLOW,
  idleState,
} from "@/lib/config";
import type { BookingStep, ChatResponse } from "@/lib/config";
import type { Slot } from "@/lib/calendar";

// ── Groq client (lazy singleton) ────────────────────────────────

let _groqClient: Groq | null = null;
function getClient(): Groq {
  if (!_groqClient) {
    _groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return _groqClient;
}

// ── RAG + LLM answer generator ──────────────────────────────────

/**
 * Generate a RAG-grounded answer using conversation history + retrieved context.
 * This is the ONLY place LLM is called for chat — everything else is deterministic.
 */
async function generateRagAnswer(
  messages: { role: string; content: string }[],
  lastMsg: string,
  maxTokens: number = MAX_TOKENS_CHAT
): Promise<string> {
  // 1. Retrieve relevant context from the RAG index
  const context = await retrieve(lastMsg, 5);

  // 2. Build system prompt with RAG context
  const systemPrompt = context
    ? `${SYSTEM_PROMPT}\n\n---\n\nRELEVANT CONTEXT FROM RESUME & GITHUB:\n\n${context}`
    : SYSTEM_PROMPT;

  // 3. Send full conversation history to Groq for memory/context
  const formattedMessages = messages.map((m) => ({
    role: m.role === "user" ? ("user" as const) : ("assistant" as const),
    content: m.content,
  }));

  const response = await getClient().chat.completions.create({
    model: GROQ_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "system", content: systemPrompt }, ...formattedMessages],
  });

  return response.choices[0]?.message?.content ?? "";
}

// ── Request parsing ─────────────────────────────────────────────

interface ParsedRequest {
  messages: { role: string; content: string }[];
  lastMsg: string;
  bookingStep: BookingStep;
  allSlots: Slot[] | null;
  pendingSlots: Slot[] | null;
  selectedSlot: Slot | null;
  slotPage: number;
}

async function parseRequest(req: Request): Promise<ParsedRequest> {
  const body = await req.json();
  const messages = body.messages as { role: string; content: string }[];

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new Error("Invalid messages");
  }

  return {
    messages,
    lastMsg: messages[messages.length - 1]?.content ?? "",
    bookingStep: body.bookingStep ?? "idle",
    allSlots: body.allSlots ?? null,
    pendingSlots: body.pendingSlots ?? null,
    selectedSlot: body.selectedSlot ?? null,
    slotPage: body.slotPage ?? 0,
  };
}

// ── Route handler ───────────────────────────────────────────────

export async function POST(req: Request) {
  try {
    const parsed = await parseRequest(req);
    const { lastMsg, messages } = parsed;

    // ── Deterministic intent classification ──
    const intent = classifyIntent(lastMsg, parsed.bookingStep);

    switch (intent) {
      // ── CANCEL: exit booking flow ──
      case "cancel": {
        return Response.json(handleCancel());
      }

      // ── BOOKING START: fetch slots and begin flow ──
      case "booking_start": {
        const result = await handleBookingStart();
        return Response.json(result);
      }

      // ── BOOKING CONTINUE: advance the state machine ──
      case "booking_continue": {
        const result = await handleBookingContinue({
          lastMsg,
          bookingStep: parsed.bookingStep,
          allSlots: parsed.allSlots,
          pendingSlots: parsed.pendingSlots,
          selectedSlot: parsed.selectedSlot,
          slotPage: parsed.slotPage,
        });

        // Booking action was handled → return directly
        if (result.type === "response") {
          return Response.json(result.data);
        }

        // Message wasn't booking-related → answer via RAG, preserve booking state
        const { state } = result;

        // Off-topic during booking → deflect + remind about booking
        if (isOffTopic(lastMsg)) {
          return Response.json({
            reply:
              "That's outside my scope — I'm focused on my professional background.\n\n---\n" +
              getBookingReminder(state),
            ...state,
          } satisfies ChatResponse);
        }

        // On-topic question during booking → RAG answer + booking reminder
        const answer = await generateRagAnswer(messages, lastMsg, MAX_TOKENS_MIDFLOW);
        const reminder = getBookingReminder(state);
        return Response.json({
          reply: `${answer}\n\n---\n${reminder}`,
          ...state,
        } satisfies ChatResponse);
      }

      // ── OFF-TOPIC: warm deflection ──
      case "off_topic": {
        return Response.json({
          reply: "That's a bit outside my lane — I'm Vinay's professional AI representative, so I'm focused on his background, technical work, and availability. What would you like to know about my work?",
          ...idleState(),
        } satisfies ChatResponse);
      }

      // ── CHAT: RAG-grounded conversation (default) ──
      case "chat": {
        const answer = await generateRagAnswer(messages, lastMsg);
        return Response.json({
          reply: answer,
          ...idleState(),
        } satisfies ChatResponse);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Chat API error:", msg);

    if (msg === "Invalid messages") {
      return Response.json({ error: msg }, { status: 400 });
    }

    return Response.json({ error: msg }, { status: 500 });
  }
}
