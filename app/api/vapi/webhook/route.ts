import { getAvailableSlots, createBooking, formatSlots, Slot } from "@/lib/calendar";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    console.log("Vapi webhook received:", JSON.stringify(body, null, 2));

    // Vapi sends function-call events
    const functionCall = body?.message?.functionCall ?? body?.functionCall;
    if (!functionCall) {
      return Response.json({ result: "ok" });
    }

    const { name, parameters } = functionCall;

    // ── getAvailableSlots ──
    if (name === "getAvailableSlots") {
      const slots = await getAvailableSlots();
      if (slots.length === 0) {
        return Response.json({
          result: "I don't have any open slots in the next 7 days. The caller can reach Vinay directly at vinay.23bcs10174@sst.scaler.com",
        });
      }
      return Response.json({
        result: `Here are the available slots: ${formatSlotsForVoice(slots)}. Ask the caller which one works and get their name and email to confirm.`,
      });
    }

    // ── createBooking ──
    if (name === "createBooking") {
      const { name: callerName, email, slotTime } = parameters ?? {};

      if (!callerName || !email || !slotTime) {
        return Response.json({
          result: "I need the caller's name, email, and chosen time slot to book the meeting.",
        });
      }

      // Find the slot object matching the slotTime
      const slots = await getAvailableSlots();
      const slot: Slot = slots.find((s) => s.start === slotTime) ?? {
        start: slotTime,
        end: new Date(new Date(slotTime).getTime() + 30 * 60000).toISOString(),
      };

      const result = await createBooking(callerName, email, slot);
      return Response.json({ result: result.message });
    }

    return Response.json({ result: "Unknown function" });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Vapi webhook error:", msg);
    return Response.json({ result: `Error: ${msg}` }, { status: 500 });
  }
}

// Voice-friendly slot format (no markdown, readable aloud)
function formatSlotsForVoice(slots: Slot[]): string {
  return slots
    .map((s, i) => {
      const d = new Date(s.start);
      const day = d.toLocaleDateString("en-IN", { weekday: "long", month: "long", day: "numeric", timeZone: "Asia/Kolkata" });
      const time = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
      return `Option ${i + 1}: ${day} at ${time} IST`;
    })
    .join(". ");
}
