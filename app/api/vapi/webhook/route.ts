import { getAvailableSlots, createBooking } from "@/lib/calendar";
import { retrieve } from "@/lib/retriever";
import { OWNER_EMAIL } from "@/lib/config";
import { normalizeSpokenEmail } from "@/lib/spoken-email";
import { parseSlotTime, snapToGrid, toSlot } from "@/lib/slots";
import { selectVoiceSlots, formatSlotsForVoice } from "@/lib/voice";

// Spoken form of the owner's address, for the TTS voice.
const SPOKEN_OWNER_EMAIL = OWNER_EMAIL.replace(/@/g, " at ").replace(/\./g, " dot ");

const FALLBACK_MSG =
  `I'm having trouble connecting right now. Please ask the caller to email Vinay directly at ${SPOKEN_OWNER_EMAIL}, or try again shortly.`;

async function handleToolCall(name: string, parameters: Record<string, string>): Promise<string> {

  // ── searchVinayBackground — RAG over resume + GitHub ──
  if (name === "searchVinayBackground") {
    const { query } = parameters ?? {};
    if (!query) return "Please ask a specific question about Vinay.";
    try {
      const context = await retrieve(query, 5);
      return context
        ? context
        : `I don't have specific information about that. You can email Vinay at ${SPOKEN_OWNER_EMAIL} for more details.`;
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
        return `Vinay has no open slots in the 9 AM to 5 PM window in the next 2 weeks. Ask the caller to email Vinay at ${SPOKEN_OWNER_EMAIL} to arrange a custom time.`;
      }

      const slotList = formatSlotsForVoice(voiceSlots);
      return `Here are Vinay's available slots:\n${slotList}\n\nRead each option aloud (skip the slotTime value). Ask which option they want. Then ask for their name and email. Then call createBooking with the slotTime of their chosen option.`;
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
      console.log(`Booking result: ${result.code}`);
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

// ── CORS Helper ──────────────────────────────────────────────────
function corsResponse(res: Response): Response {
  const newHeaders = new Headers(res.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  newHeaders.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  newHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: newHeaders,
  });
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

      return corsResponse(Response.json({ results }));
    }

    // ── Older Vapi format: function-call / functionCall ──
    const functionCall = body?.message?.functionCall ?? body?.functionCall;
    if (functionCall) {
      const { name, parameters } = functionCall;
      const result = await handleToolCall(name, parameters ?? {});
      return corsResponse(Response.json({ result }));
    }

    // Other event types (call-start, call-end, etc.) — just acknowledge
    return corsResponse(Response.json({ result: "ok" }));

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Vapi webhook error:", msg);
    return corsResponse(Response.json({ result: `Error: ${msg}` }, { status: 500 }));
  }
}

/** Health-check — lets you verify the route is deployed: GET /api/vapi/webhook */
export function GET() {
  return Response.json({ status: "ok", route: "/api/vapi/webhook", timestamp: new Date().toISOString() });
}

/** CORS preflight — some Vapi configs send OPTIONS before POST */
export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
