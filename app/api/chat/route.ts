import Groq from "groq-sdk";
import { retrieve } from "@/lib/retriever";
import { getAvailableSlots, createBooking, Slot } from "@/lib/calendar";

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

const BASE_PERSONA = `You are the AI representative of Vinay Kumar Chopra — a 3rd-year CS student at BITS Pilani (via Scaler School of Technology), CGPA 8.18/10. Speak in first person as Vinay.

RESPONSE STYLE — CRITICAL:
- Be CONCISE. Match the length to the question. A short question gets a short answer.
- For casual replies ("nice", "ok", "cool", "thanks", "got it") — respond in ONE sentence max, then ask if they have another question.
- NEVER volunteer unrequested information. Only answer what was asked. Do NOT list extra repos, projects, or facts nobody asked about.
- Use bullet points only when listing 3+ items that genuinely need structure.

WHEN ASKED ABOUT RESUME/OVERVIEW/BACKGROUND: Give a structured answer covering: education (BITS Pilani B.Sc. CS Hons, CGPA 8.18/10, Expected 2027 via Scaler), key skills (C++, Java, Python, Spring Boot), key projects (Market Data Publisher HFT system in C++, Product Service Spring Boot backend, Aadhar Seva Radar data analysis), and open-source contributions (GRASS GIS PR#7097 & PR#7005, storacha/guppy PR#195 in Go). Keep it under 120 words.

WHEN ASKED WHY I'M THE RIGHT FIT:
Be specific — mention the HFT C++ system (TCP/UDP concurrency, manual memory), Spring Boot product service (40% persistence, 25% API speed), open source contributions to GRASS GIS (PRs #7097, #7005) and storacha/guppy (PR #195 in Go). 3rd-year shipping at final-year level.

WHEN ASKED ABOUT A SPECIFIC REPO: cover tech stack, purpose, tradeoff — only for the repo asked about.

EDUCATION: BITS Pilani B.Sc.(Hons.) CS, Expected 2027, CGPA 8.18/10. Via Scaler School of Technology.

STAY GROUNDED: Only use the RAG context provided. If not in context: "I don't have that detail — reach me at vinay.23bcs10174@sst.scaler.com"

SCOPE: Professional profile only. Off-topic questions (food, sports, politics, entertainment) get a one-line warm redirect.

NEVER hallucinate — not even plausible-sounding details. If a question is ambiguous or unclear, ask "Could you clarify what you'd like to know?" rather than inventing an answer.
NEVER describe steps, workflows, UI flows, or code walkthroughs unless they are explicitly in the RAG context.
NEVER fake bookings.

Contact: vinay.23bcs10174@sst.scaler.com | +91-8822091421 | github.com/HUN-sp`;

type BookingStep = "idle" | "slots_shown" | "awaiting_email";
const PAGE_SIZE = 5;

// Format a page of slots numbered 1–N
function formatSlotsPage(slots: Slot[], page: number): string {
  const start = page * PAGE_SIZE;
  const pageSlots = slots.slice(start, start + PAGE_SIZE);
  if (pageSlots.length === 0) return "No more slots available.";
  return pageSlots
    .map((s, i) => {
      const d = new Date(s.start);
      return `${i + 1}. ${d.toLocaleDateString("en-IN", { weekday: "long", month: "short", day: "numeric" })} at ${d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST`;
    })
    .join("\n");
}

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

function detectMoreSlotsRequest(message: string): boolean {
  const lower = message.toLowerCase();
  return [
    "more slot", "other slot", "different slot", "show more",
    "other time", "different time", "other option", "none of these",
    "none work", "something else", "not these", "any other",
    "what else", "more option", "next 5", "other date", "different date",
    "show other", "other availability",
  ].some((s) => lower.includes(s));
}

// Guard rail: catch clearly off-topic messages before hitting the LLM
function isOffTopic(message: string): boolean {
  const lower = message.toLowerCase().trim();
  if (lower.split(/\s+/).length <= 4) return false; // short greetings always pass

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

// Parses "9:30 am", "9:30", "10am" → { hour, minute }
// Requires colon OR meridiem to avoid false-matches on dates like "16 Apr"
function parseTime(message: string): { hour: number; minute: number } | null {
  const colonMatch = message.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  if (colonMatch) {
    let h = parseInt(colonMatch[1]), m = parseInt(colonMatch[2]);
    const mer = colonMatch[3]?.toLowerCase();
    if (mer === "pm" && h !== 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    if (h >= 0 && h < 24 && m >= 0 && m < 60) return { hour: h, minute: m };
  }
  const shortMatch = message.match(/\b(\d{1,2})\s*(am|pm)\b/i);
  if (shortMatch) {
    let h = parseInt(shortMatch[1]);
    const mer = shortMatch[2].toLowerCase();
    if (mer === "pm" && h !== 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    if (h >= 0 && h < 24) return { hour: h, minute: 0 };
  }
  return null;
}

// Parses "15 April", "April 15", "15th April", "April 15th" → Date
function parseDateFromText(message: string): Date | null {
  const lower = message.toLowerCase();
  const months = [
    "january","february","march","april","may","june",
    "july","august","september","october","november","december",
  ];
  for (let mi = 0; mi < months.length; mi++) {
    const m = months[mi];
    if (!lower.includes(m)) continue;
    // "15 April" or "15th April"
    const before = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+${m}`).exec(lower);
    if (before) {
      const day = parseInt(before[1]);
      return new Date(new Date().getFullYear(), mi, day);
    }
    // "April 15" or "April 15th"
    const after = new RegExp(`${m}\\s+(\\d{1,2})(?:st|nd|rd|th)?`).exec(lower);
    if (after) {
      const day = parseInt(after[1]);
      return new Date(new Date().getFullYear(), mi, day);
    }
  }
  return null;
}

function formatReadableSlot(d: Date): string {
  return `${d.toLocaleDateString("en-IN", { weekday: "long", month: "short", day: "numeric" })} at ${d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST`;
}

function slotTimeLabel(s: Slot): string {
  const IST = (5 * 60 + 30) * 60_000;
  const ist = new Date(new Date(s.start).getTime() + IST);
  const h = ist.getUTCHours(), m = ist.getUTCMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} IST`;
}

type SlotDetection =
  | { type: "found"; slot: Slot }
  | { type: "ambiguous_day"; daySlots: Slot[]; dayName: string }
  | { type: "ambiguous_time"; timeSlots: Slot[]; timeLabel: string }
  | { type: "not_found" };

// pageOffset: slotPage * PAGE_SIZE — maps displayed number (1-5) back to index in full slots array
function detectSlotChoice(message: string, slots: Slot[], pageOffset = 0): SlotDetection {
  const lower = message.toLowerCase();
  const days = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
  const IST = (5 * 60 + 30) * 60_000;

  // Number pick (1–N) — relative to current page
  const numMatch = lower.match(/\b([1-9])\b/);
  if (numMatch) {
    const idx = parseInt(numMatch[1]) - 1 + pageOffset;
    if (slots[idx]) return { type: "found", slot: slots[idx] };
  }

  const parsedTime = parseTime(message);

  // Day name match
  for (const day of days) {
    if (!lower.includes(day)) continue;
    const daySlots = slots.filter((s) =>
      new Date(s.start).toLocaleDateString("en-US", { weekday: "long" }).toLowerCase() === day
    );
    if (daySlots.length === 0) continue;

    if (parsedTime) {
      const exact = daySlots.find((s) => {
        const ist = new Date(new Date(s.start).getTime() + IST);
        return ist.getUTCHours() === parsedTime.hour && ist.getUTCMinutes() === parsedTime.minute;
      });
      if (exact) return { type: "found", slot: exact };
    }

    if (daySlots.length === 1) return { type: "found", slot: daySlots[0] };
    return { type: "ambiguous_day", daySlots, dayName: day };
  }

  // Time-only match (works great when pendingSlots is narrowed to a day)
  if (parsedTime) {
    const timeMatches = slots.filter((s) => {
      const ist = new Date(new Date(s.start).getTime() + IST);
      return ist.getUTCHours() === parsedTime.hour && ist.getUTCMinutes() === parsedTime.minute;
    });
    if (timeMatches.length === 1) return { type: "found", slot: timeMatches[0] };
    if (timeMatches.length > 1) {
      const h = parsedTime.hour, m = parsedTime.minute;
      const timeLabel = `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
      return { type: "ambiguous_time", timeSlots: timeMatches, timeLabel };
    }
  }

  // "today" / "tomorrow" shorthand
  const relativeDay = lower.includes("tomorrow")
    ? new Date(Date.now() + 86_400_000).toDateString()
    : lower.includes("today")
    ? new Date().toDateString()
    : null;

  if (relativeDay) {
    const relSlots = slots.filter((s) => new Date(s.start).toDateString() === relativeDay);
    if (relSlots.length === 1) return { type: "found", slot: relSlots[0] };
    if (relSlots.length > 1) {
      const label = lower.includes("tomorrow") ? "tomorrow" : "today";
      return { type: "ambiguous_day", daySlots: relSlots, dayName: label };
    }
  }

  // "15 April", "April 15", "15th April" etc.
  const parsedDate = parseDateFromText(message);
  if (parsedDate) {
    const dateStr = parsedDate.toDateString();
    const dateSlots = slots.filter((s) => new Date(s.start).toDateString() === dateStr);
    if (dateSlots.length === 1) return { type: "found", slot: dateSlots[0] };
    if (dateSlots.length > 1) {
      const dayName = parsedDate.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
      return { type: "ambiguous_day", daySlots: dateSlots, dayName };
    }
  }

  return { type: "not_found" };
}

function extractEmail(message: string): string | null {
  // [\w.-]+ handles multi-part domains like sst.scaler.com (fixes *.com being cut off)
  const match = message.match(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
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
    const { messages, bookingStep, pendingSlots, selectedSlot, slotPage = 0 } = await req.json() as {
      messages: { role: string; content: string }[];
      bookingStep: BookingStep;
      pendingSlots: Slot[] | null;
      selectedSlot: Slot | null;
      slotPage: number;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return Response.json({ error: "Invalid messages" }, { status: 400 });
    }

    const lastMsg = messages[messages.length - 1]?.content ?? "";

    // ── CANCEL: user wants to exit an active booking flow ──
    if (bookingStep !== "idle") {
      const lower = lastMsg.toLowerCase();
      const cancelSignals = [
        "cancel", "nevermind", "never mind", "forget it", "don't want",
        "not interested", "bye", "goodbye", "exit", "stop", "quit",
        "not in the mood", "no thanks", "nope", "nah", "not now",
        "i don't want", "not want", "won't", "leave it",
      ];
      if (cancelSignals.some((s) => lower.includes(s))) {
        return Response.json({
          reply: "No worries at all! Feel free to ask anything else about my background or reach out at vinay.23bcs10174@sst.scaler.com whenever you're ready.",
          bookingStep: "idle", pendingSlots: null, selectedSlot: null, slotPage: 0,
        });
      }
    }

    // ── STEP 1: Booking intent → fetch all slots, show first PAGE_SIZE ──
    if ((bookingStep === "idle" || !bookingStep) && detectBookingIntent(lastMsg)) {
      const slots = await getAvailableSlots();
      if (slots.length === 0) {
        return Response.json({
          reply: "I don't have any open slots in the next 2 weeks. Reach out directly at vinay.23bcs10174@sst.scaler.com to arrange a time.",
          bookingStep: "idle", pendingSlots: null, selectedSlot: null, slotPage: 0,
        });
      }
      const hasMore = slots.length > PAGE_SIZE;
      const hint = hasMore
        ? `\n\nReply with a number (1–5), day name, or **"more slots"** to see the next 5.`
        : `\n\nWhich one works for you? Reply with the number or day name.`;
      return Response.json({
        reply: `Here are my next available slots:\n\n${formatSlotsPage(slots, 0)}${hint}`,
        bookingStep: "slots_shown", pendingSlots: slots, selectedSlot: null, slotPage: 0,
      });
    }

    // ── STEP 2: User picks a slot (or asks for more) ──
    if (bookingStep === "slots_shown" && pendingSlots) {

      // "More slots" request — advance to next page
      if (detectMoreSlotsRequest(lastMsg)) {
        const newPage = slotPage + 1;
        const newPageSlots = pendingSlots.slice(newPage * PAGE_SIZE, (newPage + 1) * PAGE_SIZE);
        if (newPageSlots.length === 0) {
          return Response.json({
            reply: `Those are all my available slots for the next 2 weeks. You can also reach me at vinay.23bcs10174@sst.scaler.com.\n\nHere's a reminder of the first set:\n\n${formatSlotsPage(pendingSlots, 0)}`,
            bookingStep: "slots_shown", pendingSlots, selectedSlot: null, slotPage: 0,
          });
        }
        const hasMore = pendingSlots.length > (newPage + 1) * PAGE_SIZE;
        const hint = hasMore
          ? `\n\nReply with a number, day name, or **"more slots"** for the next 5.`
          : `\n\nWhich one works?`;
        return Response.json({
          reply: `Here are more available slots:\n\n${formatSlotsPage(pendingSlots, newPage)}${hint}`,
          bookingStep: "slots_shown", pendingSlots, selectedSlot: null, slotPage: newPage,
        });
      }

      const pageOffset = slotPage * PAGE_SIZE;
      const detection = detectSlotChoice(lastMsg, pendingSlots, pageOffset);

      if (detection.type === "found") {
        const readable = formatReadableSlot(new Date(detection.slot.start));
        return Response.json({
          reply: `Perfect — **${readable}** it is.\n\nPlease share your **name and email** to confirm the booking.`,
          bookingStep: "awaiting_email", pendingSlots, selectedSlot: detection.slot, slotPage,
        });
      }

      if (detection.type === "ambiguous_day") {
        const cap = detection.dayName.charAt(0).toUpperCase() + detection.dayName.slice(1);
        const opts = detection.daySlots.map((s, i) => `${i + 1}. ${slotTimeLabel(s)}`).join("\n");
        return Response.json({
          reply: `I have ${detection.daySlots.length} slots on ${cap}:\n\n${opts}\n\nWhich time works?`,
          bookingStep: "slots_shown", pendingSlots: detection.daySlots, selectedSlot: null, slotPage: 0,
        });
      }

      if (detection.type === "ambiguous_time") {
        const dayOpts = detection.timeSlots
          .map((s, i) => `${i + 1}. ${new Date(s.start).toLocaleDateString("en-IN", { weekday: "long", month: "short", day: "numeric" })}`)
          .join("\n");
        return Response.json({
          reply: `${detection.timeLabel} IST is available on:\n\n${dayOpts}\n\nWhich day works?`,
          bookingStep: "slots_shown", pendingSlots: detection.timeSlots, selectedSlot: null, slotPage: 0,
        });
      }

      // not_found
      return Response.json({
        reply: `I didn't catch which slot. Reply with a number (1–${Math.min(PAGE_SIZE, pendingSlots.length - slotPage * PAGE_SIZE)}), a day name, or the date.\n\n${formatSlotsPage(pendingSlots, slotPage)}`,
        bookingStep: "slots_shown", pendingSlots, selectedSlot: null, slotPage,
      });
    }

    // ── STEP 3: Name + email received → create booking ──
    if (bookingStep === "awaiting_email" && selectedSlot) {
      const email = extractEmail(lastMsg);

      // No email yet — check if user is correcting the slot
      if (!email && pendingSlots) {
        const detection = detectSlotChoice(lastMsg, pendingSlots, slotPage * PAGE_SIZE);
        if (detection.type === "found") {
          const readable = formatReadableSlot(new Date(detection.slot.start));
          return Response.json({
            reply: `No problem — updated to **${readable}**.\n\nPlease share your **name and email** to confirm.`,
            bookingStep: "awaiting_email", pendingSlots, selectedSlot: detection.slot, slotPage,
          });
        }
        if (detection.type === "ambiguous_day") {
          const cap = detection.dayName.charAt(0).toUpperCase() + detection.dayName.slice(1);
          const opts = detection.daySlots.map((s, i) => `${i + 1}. ${slotTimeLabel(s)}`).join("\n");
          return Response.json({
            reply: `Which ${cap} slot?\n\n${opts}`,
            bookingStep: "slots_shown", pendingSlots: detection.daySlots, selectedSlot: null, slotPage: 0,
          });
        }
      }

      if (!email) {
        return Response.json({
          reply: "I need your email to confirm. Could you share it?",
          bookingStep: "awaiting_email", pendingSlots, selectedSlot, slotPage,
        });
      }
      const name = extractName(lastMsg, email);
      const result = await createBooking(name, email, selectedSlot);
      return Response.json({
        reply: result.message,
        bookingStep: "idle", pendingSlots: null, selectedSlot: null, slotPage: 0,
      });
    }

    // ── GUARD RAIL: off-topic deflection ──
    if (isOffTopic(lastMsg)) {
      return Response.json({
        reply: "That's a bit outside my lane — I'm Vinay's professional AI representative, so I'm focused on his background, technical work, and availability. Is there something on that front I can help with?",
        bookingStep: "idle", pendingSlots: null, selectedSlot: null, slotPage: 0,
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
      model: "llama-3.3-70b-versatile",
      max_tokens: 1024,
      messages: [{ role: "system", content: systemPrompt }, ...formattedMessages],
    });

    const text = response.choices[0]?.message?.content ?? "";
    return Response.json({ reply: text, bookingStep: "idle", pendingSlots: null, selectedSlot: null, slotPage: 0 });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Chat API error:", msg);
    return Response.json({ error: msg }, { status: 500 });
  }
}
