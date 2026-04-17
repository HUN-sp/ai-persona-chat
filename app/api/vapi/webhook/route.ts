import { getAvailableSlots, createBooking, Slot } from "@/lib/calendar";
import { retrieve } from "@/lib/retriever";

const FALLBACK_MSG =
  "I'm having trouble connecting right now. Please ask the caller to email Vinay directly at vinay dot 23bcs10174 at sst dot scaler dot com, or try again shortly.";

// ── Ordinal suffix: 1 → "1st", 23 → "23rd" (TTS reads these naturally) ──
function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:  return `${n}st`;
    case 2:  return `${n}nd`;
    case 3:  return `${n}rd`;
    default: return `${n}th`;
  }
}

// ── Pick slots for voice: 9am–5pm IST only, max 4 per day, max 3 days ──
function selectVoiceSlots(slots: Slot[]): Slot[] {
  const byDay = new Map<string, Slot[]>();

  for (const s of slots) {
    const d = new Date(s.start);
    // IST hour for business-hours filter
    const istHour = parseInt(
      d.toLocaleTimeString("en-US", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" })
    );
    if (istHour < 9 || istHour >= 17) continue; // keep only 9 AM – 5 PM

    const dayKey = d.toLocaleDateString("en-US", {
      timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    });
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    if (byDay.get(dayKey)!.length < 4) byDay.get(dayKey)!.push(s); // max 4/day
  }

  const result: Slot[] = [];
  let dayCount = 0;
  for (const daySlots of byDay.values()) {
    if (dayCount >= 3) break; // max 3 days
    result.push(...daySlots);
    dayCount++;
  }
  return result;
}

// ── Format: readable grouped list + internal slot refs the LLM won't say aloud ──
function formatSlotsForVoice(slots: Slot[]): string {
  const byDay = new Map<string, { label: string; slots: Slot[] }>();

  for (const s of slots) {
    const d = new Date(s.start);
    const dayKey = d.toLocaleDateString("en-US", {
      timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    });

    if (!byDay.has(dayKey)) {
      const weekday = d.toLocaleDateString("en-US", { weekday: "long",  timeZone: "Asia/Kolkata" });
      const month   = d.toLocaleDateString("en-US", { month:   "long",  timeZone: "Asia/Kolkata" });
      const dayNum  = parseInt(d.toLocaleDateString("en-US", { day: "numeric", timeZone: "Asia/Kolkata" }));
      byDay.set(dayKey, { label: `${weekday}, ${month} ${ordinal(dayNum)}`, slots: [] });
    }
    byDay.get(dayKey)!.slots.push(s);
  }

  let optNum = 1;
  const spokenLines: string[] = [];
  const slotRefs:    string[] = [];

  for (const { label, slots: daySlots } of byDay.values()) {
    const times = daySlots.map((s) => {
      const time = new Date(s.start).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata",
      });
      slotRefs.push(`OPT${optNum}=${s.start}`);
      return `Option ${optNum++} at ${time}`;
    }).join(", ");

    spokenLines.push(`${label}: ${times}`);
  }

  // Two-section response — LLM reads the first, uses the second internally
  return (
    `READ_ALOUD_TO_CALLER:\n${spokenLines.join("\n")}\n\n` +
    `SLOT_REFS_FOR_BOOKING_DO_NOT_SAY:\n${slotRefs.join("\n")}`
  );
}

async function handleToolCall(name: string, parameters: Record<string, string>): Promise<string> {

  // ── searchVinayBackground — RAG over resume + GitHub ──
  if (name === "searchVinayBackground") {
    const { query } = parameters ?? {};
    if (!query) return "Please ask a specific question about Vinay.";
    try {
      const context = await retrieve(query, 5);
      return context
        ? context
        : "I don't have specific information about that. You can email Vinay at vinay dot 23bcs10174 at sst dot scaler dot com for more details.";
    } catch (e) {
      console.error("searchVinayBackground error:", e);
      return FALLBACK_MSG;
    }
  }

  // ── getAvailableSlots ──
  if (name === "getAvailableSlots") {
    try {
      const allSlots = await getAvailableSlots();
      const voiceSlots = selectVoiceSlots(allSlots);

      if (voiceSlots.length === 0) {
        return "Vinay has no open slots in the 9 AM to 5 PM window in the next 2 weeks. Ask the caller to email Vinay at vinay dot 23bcs10174 at sst dot scaler dot com to arrange a custom time.";
      }

      return (
        `${formatSlotsForVoice(voiceSlots)}\n\n` +
        `INSTRUCTIONS_DO_NOT_SAY:\n` +
        `1. Read only the READ_ALOUD_TO_CALLER section above, option by option.\n` +
        `2. Ask: "Which option works for you?"\n` +
        `3. Once they choose, ask: "What is your full name and email address?"\n` +
        `4. Call createBooking immediately using the matching OPT timestamp from SLOT_REFS_FOR_BOOKING.\n` +
        `5. Do NOT call getAvailableSlots again under any circumstances.`
      );
    } catch (e) {
      console.error("getAvailableSlots error:", e);
      return FALLBACK_MSG;
    }
  }

  // ── createBooking ──
  if (name === "createBooking") {
    const { name: callerName, email: rawEmail, slotTime } = parameters ?? {};
    if (!callerName || !rawEmail || !slotTime) {
      return "Missing information — I need the caller's full name, email address, and chosen slot time to complete the booking.";
    }

    // Normalise spoken email: "john dot smith at gmail dot com" → "john.smith@gmail.com"
    const email = rawEmail
      .replace(/\s+dot\s+/gi,      ".")
      .replace(/\s+at\s+/gi,       "@")
      .replace(/\bthe\s+rate\b/gi, "@")
      .replace(/\s+minus\s+/gi,    "")  // STT artifact
      .replace(/\s+/g,             "")
      .toLowerCase();

    const emailValid = /^[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}$/.test(email);
    if (!emailValid) {
      return (
        `The email address wasn't captured correctly — the transcription may have garbled it. ` +
        `Ask the caller to say their email in this format: username, then "at", then domain. ` +
        `For example: "john dot smith at gmail dot com". Do not ask them to spell it letter by letter.`
      );
    }

    try {
      const allSlots = await getAvailableSlots();

      // Fuzzy-match: ISO timestamp from OPT refs should match exactly; 2-min window handles drift
      const targetMs = new Date(slotTime).getTime();
      const slot: Slot = allSlots.find((s) =>
        Math.abs(new Date(s.start).getTime() - targetMs) < 2 * 60 * 1000
      ) ?? {
        start: new Date(targetMs).toISOString(),
        end:   new Date(targetMs + 30 * 60_000).toISOString(),
      };

      console.log(`Booking: ${callerName} <${email}> @ ${slot.start}`);
      const result = await createBooking(callerName, email, slot);
      console.log("Booking result:", result.message);
      return result.message;
    } catch (e) {
      console.error("createBooking error:", e);
      return FALLBACK_MSG;
    }
  }

  return "Unknown tool — please only call searchVinayBackground, getAvailableSlots, or createBooking.";
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    console.log("Vapi webhook:", JSON.stringify(body).slice(0, 400));

    const msgType = body?.message?.type;

    // ── Newer Vapi format: tool-calls ──
    if (msgType === "tool-calls") {
      const toolCallList: { id: string; function: { name: string; arguments: string } }[] =
        body.message.toolCallList ?? [];

      const results = await Promise.all(
        toolCallList.map(async (tc) => {
          let params: Record<string, string> = {};
          try { params = JSON.parse(tc.function.arguments ?? "{}"); } catch { /* ignore */ }
          const result = await handleToolCall(tc.function.name, params);
          return { toolCallId: tc.id, result };
        })
      );

      return Response.json({ results });
    }

    // ── Older Vapi format: function-call / functionCall ──
    const functionCall = body?.message?.functionCall ?? body?.functionCall;
    if (functionCall) {
      const { name, parameters } = functionCall;
      const result = await handleToolCall(name, parameters ?? {});
      return Response.json({ result });
    }

    // Other event types (call-start, call-end, etc.) — just acknowledge
    return Response.json({ result: "ok" });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Vapi webhook error:", msg);
    return Response.json({ result: `Error: ${msg}` }, { status: 500 });
  }
}
