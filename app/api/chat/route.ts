import Groq from "groq-sdk";
import { retrieve } from "@/lib/retriever";
import { getAvailableSlots, createBooking, formatSlots, Slot } from "@/lib/calendar";

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

const BASE_PERSONA = `You are the AI representative of Vinay Kumar Chopra. Speak in first person ("I", "my", "me"). Be warm, honest, confident, and specific. Never hallucinate — if you don't know something, say so clearly.

You have access to Vinay's actual resume and GitHub codebase as context below. Always ground your answers in that context.

IMPORTANT: Never pretend to book, schedule, or confirm a meeting. The booking system handles this — do not generate fake booking confirmations.

Rules:
1. Always answer as Vinay in first person.
2. If asked something not in context, say: "I don't have that info — reach me at vinay.23bcs10174@sst.scaler.com"
3. Never make up skills, projects, or experiences not in the context.
4. Keep answers concise and specific.

Contact: vinay.23bcs10174@sst.scaler.com | +91-8822091421 | github.com/HUN-sp`;

type BookingStep = "idle" | "slots_shown" | "awaiting_email";

function detectBookingIntent(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("book") ||
    lower.includes("schedule") ||
    lower.includes("availability") ||
    lower.includes("available") ||
    lower.includes("meeting") ||
    lower.includes("interview") ||
    lower.includes("call") ||
    lower.includes("slot")
  );
}

function detectSlotChoice(message: string, slots: Slot[]): Slot | null {
  const lower = message.toLowerCase();
  const days = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];

  const numMatch = lower.match(/\b([1-6])\b/);
  if (numMatch) {
    const idx = parseInt(numMatch[1]) - 1;
    if (slots[idx]) return slots[idx];
  }

  for (const day of days) {
    if (lower.includes(day)) {
      const match = slots.find((s) =>
        new Date(s.start).toLocaleDateString("en-US", { weekday: "long" }).toLowerCase() === day
      );
      if (match) return match;
    }
  }

  if (lower.includes("today")) {
    const today = new Date().toDateString();
    const match = slots.find((s) => new Date(s.start).toDateString() === today);
    if (match) return match;
  }

  return null;
}

function extractEmail(message: string): string | null {
  const match = message.match(/[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

function extractName(message: string, email: string): string {
  const cleaned = message.replace(email, "").replace(/[,]/g, " ").trim();
  const nameMatch = cleaned.match(/\b([A-Z][a-z]+ [A-Z][a-z]+)\b/);
  if (nameMatch) return nameMatch[1];
  const words = cleaned.replace(/[^a-zA-Z ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 2).join(" ");
  if (words.length === 1) return words[0];
  return "Guest";
}

export async function POST(req: Request) {
  try {
    const { messages, bookingStep, pendingSlots, selectedSlot } = await req.json() as {
      messages: { role: string; content: string }[];
      bookingStep: BookingStep;
      pendingSlots: Slot[] | null;
      selectedSlot: Slot | null;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return Response.json({ error: "Invalid messages" }, { status: 400 });
    }

    const lastMsg = messages[messages.length - 1]?.content ?? "";

    // ── STEP 1: Booking intent → fetch real slots from Calendly ──
    if ((bookingStep === "idle" || !bookingStep) && detectBookingIntent(lastMsg)) {
      const slots = await getAvailableSlots();
      if (slots.length === 0) {
        return Response.json({
          reply: "I don't have any open slots in the next 7 days. Reach out directly at vinay.23bcs10174@sst.scaler.com to arrange a time.",
          bookingStep: "idle", pendingSlots: null, selectedSlot: null,
        });
      }
      return Response.json({
        reply: `Here are my real available slots for the next 7 days:\n\n${formatSlots(slots)}\n\nWhich one works for you? Reply with the number or day name.`,
        bookingStep: "slots_shown", pendingSlots: slots, selectedSlot: null,
      });
    }

    // ── STEP 2: User picks a slot → ask for name + email ──
    if (bookingStep === "slots_shown" && pendingSlots) {
      const chosen = detectSlotChoice(lastMsg, pendingSlots);
      if (chosen) {
        const d = new Date(chosen.start);
        const readable = `${d.toLocaleDateString("en-IN", { weekday: "long", month: "short", day: "numeric" })} at ${d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST`;
        return Response.json({
          reply: `Perfect — **${readable}** it is.\n\nPlease share your **name and email** to confirm the booking.`,
          bookingStep: "awaiting_email", pendingSlots, selectedSlot: chosen,
        });
      }
      return Response.json({
        reply: `Sorry, I didn't catch which slot. Reply with a number (1–${pendingSlots.length}) or the day name.\n\n${formatSlots(pendingSlots)}`,
        bookingStep: "slots_shown", pendingSlots, selectedSlot: null,
      });
    }

    // ── STEP 3: Name + email received → create real booking ──
    if (bookingStep === "awaiting_email" && selectedSlot) {
      const email = extractEmail(lastMsg);
      if (!email) {
        return Response.json({
          reply: "I need your email to confirm. Could you share it?",
          bookingStep: "awaiting_email", pendingSlots, selectedSlot,
        });
      }
      const name = extractName(lastMsg, email);
      const result = await createBooking(name, email, selectedSlot);
      return Response.json({
        reply: result.message,
        bookingStep: "idle", pendingSlots: null, selectedSlot: null,
      });
    }

    // ── DEFAULT: RAG-grounded chat ──
    const context = await retrieve(lastMsg, 5);
    const systemPrompt = context
      ? `${BASE_PERSONA}\n\n---\n\nRELEVANT CONTEXT FROM RESUME & GITHUB:\n\n${context}`
      : BASE_PERSONA;

    const formattedMessages = messages.map((m) => ({
      role: m.role === "user" ? "user" as const : "assistant" as const,
      content: m.content,
    }));

    const response = await client.chat.completions.create({
      model: "llama-3.1-8b-instant",
      max_tokens: 1024,
      messages: [{ role: "system", content: systemPrompt }, ...formattedMessages],
    });

    const text = response.choices[0]?.message?.content ?? "";
    return Response.json({ reply: text, bookingStep: "idle", pendingSlots: null, selectedSlot: null });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Chat API error:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
