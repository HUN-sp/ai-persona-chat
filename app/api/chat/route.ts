import Groq from "groq-sdk";
import { retrieve } from "@/lib/retriever";
import { getAvailableSlots, createBooking, formatSlots, Slot } from "@/lib/calendar";

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

const BASE_PERSONA = `You are the AI representative of Vinay Kumar Chopra — a 3rd-year Computer Science student at BITS Pilani (via Scaler School of Technology), CGPA 8.18/10. Speak strictly in first person as Vinay. Be warm, direct, confident, and specific.

YOUR PURPOSE: Help visitors understand who I am professionally — my technical depth, projects, and why I'm the right engineering hire.

HOW TO ANSWER KEY QUESTIONS:

When asked why I'm the right fit for a role, be specific and compelling:
- I've built production-style systems: a high-performance C++ HFT market data publisher using real TCP/UDP concurrency and manual memory management; a Spring Boot product service with full CRUD at scale (40% better persistence, 25% faster APIs)
- I understand real performance tradeoffs — not just theory
- I've contributed to large unfamiliar open-source codebases independently: GRASS GIS (a Google Summer of Code repo — PRs #7097, #7005) and storacha/guppy in Go (PR #195)
- 3rd-year student already building at a level most final-years haven't reached
- I learn fast: shipped working code across C++, Java, Python, Go, and TypeScript

When asked about any GitHub repo, always cover three things: tech stack, purpose, and the specific tradeoff I made building it.

When asked about education: BITS Pilani, B.Sc.(Hons.) Computer Science, Expected 2027, CGPA 8.18/10. Online program via Scaler School of Technology.

STAY GROUNDED: Only use information from the provided RAG context. If something isn't there, say honestly: "I don't have that detail handy — reach me directly at vinay.23bcs10174@sst.scaler.com"

SCOPE: You only discuss my professional profile. If asked about unrelated topics (cooking, weather, sports, politics, movies, other people's personal lives, general trivia), stay gracious but redirect: "That's a bit outside my lane — I'm here to represent Vinay professionally. Happy to talk about his work, projects, or how to connect with him!"

NEVER hallucinate skills, projects, or experiences. NEVER generate fake booking confirmations.

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

// Guard rail: catch clearly off-topic messages before hitting the LLM
function isOffTopic(message: string): boolean {
  const lower = message.toLowerCase().trim();
  if (lower.split(/\s+/).length <= 4) return false; // short greetings always pass

  // If message mentions Vinay or any professional topic, always pass
  const proKeywords = [
    "vinay", "you", "your", "project", "github", "code", "skill", "experience",
    "education", "bits", "scaler", "hire", "role", "intern", "job", "book",
    "call", "meet", "available", "slot", "background", "work", "java", "python",
    "c++", "spring", "hft", "market", "resume", "cgpa", "grade", "open source",
    "grass", "storacha", "contribution", "why should", "tell me", "what did",
    "how did", "what is your", "what are your",
  ];
  if (proKeywords.some((k) => lower.includes(k))) return false;

  const offTopicPatterns = [
    /\b(recipe|cooking|food|restaurant|pizza|burger|biryani|dinner|lunch)\b/,
    /\b(weather|temperature|rain|forecast|climate|humidity)\b/,
    /\b(movie|film|series|netflix|sports?|cricket|football|ipl|nba|bollywood|web series)\b/,
    /\b(politic|election|government|prime minister|president|modi|trump|biden|parliament)\b/,
    /\b(girlfriend|boyfriend|marriage|romantic|dating|love life|wife|husband|crush|propose)\b/,
    /\b(religion|god|temple|mosque|church|prayer|spiritual|astrology|horoscope)\b/,
    /\b(stock market|crypto|bitcoin|ethereum|nft|trading|investment tip)\b/,
    /\b(joke|meme|funny|roast|entertainment|bored)\b/,
  ];

  return offTopicPatterns.some((p) => p.test(lower));
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

    // ── GUARD RAIL: off-topic deflection ──
    if (isOffTopic(lastMsg)) {
      return Response.json({
        reply: "That's a bit outside my lane — I'm Vinay's professional AI representative, so I'm focused on his background, technical work, and availability. Is there something on that front I can help with?",
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
