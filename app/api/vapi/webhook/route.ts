import { getAvailableSlots, createBooking, Slot } from "@/lib/calendar";
import { retrieve } from "@/lib/retriever";

// Voice-friendly slot format — no markdown, readable aloud
function formatSlotsForVoice(slots: Slot[]): string {
  return slots
    .map((s, i) => {
      const d = new Date(s.start);
      const day  = d.toLocaleDateString("en-IN", { weekday: "long", month: "long", day: "numeric", timeZone: "Asia/Kolkata" });
      const time = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
      return `Option ${i + 1}: ${day} at ${time} IST`;
    })
    .join(". ");
}

const FALLBACK_MSG = "I'm having trouble connecting right now. Please ask the caller to email Vinay directly at vinay dot 23bcs10174 at sst dot scaler dot com, or try again shortly.";

async function handleToolCall(name: string, parameters: Record<string, string>): Promise<string> {

  // ── searchVinayBackground — RAG over resume + GitHub ──
  if (name === "searchVinayBackground") {
    const { query } = parameters ?? {};
    if (!query) return "Please ask a specific question about Vinay.";
    try {
      const context = await retrieve(query, 5);
      if (!context) {
        return "I don't have specific information about that. You can email Vinay at vinay dot 23bcs10174 at sst dot scaler dot com for more details.";
      }
      return context;
    } catch (e) {
      console.error("searchVinayBackground error:", e);
      return FALLBACK_MSG;
    }
  }

  // ── getAvailableSlots ──
  if (name === "getAvailableSlots") {
    try {
      const slots = await getAvailableSlots(5); // show only next 5 for voice
      if (slots.length === 0) {
        return "Vinay has no open slots in the next 2 weeks. Ask the caller to reach him at vinay dot 23bcs10174 at sst dot scaler dot com to arrange a custom time.";
      }
      return `Got the slots. Here they are: ${formatSlotsForVoice(slots)}. Ask the caller which option works, then get their name and email to book.`;
    } catch (e) {
      console.error("getAvailableSlots error:", e);
      return FALLBACK_MSG;
    }
  }

  // ── createBooking ──
  if (name === "createBooking") {
    const { name: callerName, email: rawEmail, slotTime } = parameters ?? {};
    if (!callerName || !rawEmail || !slotTime) {
      return "Missing information — I need the caller's full name, email address, and the chosen slot time to complete the booking.";
    }

    // Clean up email: LLM sometimes passes spoken form like "vinay dot ... at sst dot scaler dot com"
    const email = rawEmail
      .replace(/\s+dot\s+/gi, ".")
      .replace(/\s+at\s+/gi, "@")
      .replace(/\s+/g, "")
      .toLowerCase();

    const emailValid = /^[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}$/.test(email);
    if (!emailValid) {
      return `I couldn't parse that email address. Could you ask the caller to spell it out one character at a time?`;
    }

    try {
      const slots = await getAvailableSlots();

      // Fuzzy match: find slot within 2 minutes of provided time
      const targetMs = new Date(slotTime).getTime();
      const slot: Slot = slots.find((s) =>
        Math.abs(new Date(s.start).getTime() - targetMs) < 2 * 60 * 1000
      ) ?? {
        start: new Date(targetMs).toISOString(),
        end: new Date(targetMs + 30 * 60000).toISOString(),
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

  return "Unknown function — please only use searchVinayBackground, getAvailableSlots, or createBooking.";
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
