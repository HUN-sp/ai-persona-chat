import { google } from "googleapis";

export interface Slot {
  start: string;
  end: string;
}

function getAuth() {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "http://localhost"
  );
  oAuth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  return oAuth2Client;
}

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000; // 330 minutes

// Generate 30-min slots 9am–5:30pm IST on weekdays, correctly handling IST timezone.
// Key insight: treat IST calendar dates as UTC for day-of-week arithmetic, then subtract
// the IST offset to get actual UTC timestamps.
function generateSlots(startDate: Date, endDate: Date): { start: Date; end: Date }[] {
  const slots: { start: Date; end: Date }[] = [];

  // Get the IST calendar date (year/month/day in IST) for startDate
  const istStart = new Date(startDate.getTime() + IST_OFFSET_MS);
  const baseYear = istStart.getUTCFullYear();
  const baseMonth = istStart.getUTCMonth();
  const baseDay = istStart.getUTCDate();

  for (let d = 0; d <= 7; d++) {
    // Using Date.UTC with IST calendar values: getUTCDay() returns the correct IST day-of-week
    const istDateMs = Date.UTC(baseYear, baseMonth, baseDay + d);
    if (new Date(istDateMs).getUTCDay() % 6 === 0) continue; // skip Sun(0) and Sat(6)

    for (let hour = 9; hour < 18; hour++) {
      for (const min of [0, 30]) {
        // IST slot time expressed as a UTC timestamp (then shift to real UTC)
        const istSlotMs = Date.UTC(baseYear, baseMonth, baseDay + d, hour, min, 0);
        const slotStart = new Date(istSlotMs - IST_OFFSET_MS);
        const slotEnd   = new Date(slotStart.getTime() + 30 * 60_000);

        if (slotStart > startDate && slotStart < endDate) {
          slots.push({ start: slotStart, end: slotEnd });
        }
      }
    }
  }
  return slots;
}

// Return at most 2 slots per IST calendar day so the user sees variety across the week
function pickVariedSlots(slots: { start: Date; end: Date }[]): { start: Date; end: Date }[] {
  const byDay = new Map<string, { start: Date; end: Date }[]>();
  for (const slot of slots) {
    const ist = new Date(slot.start.getTime() + IST_OFFSET_MS);
    const key = `${ist.getUTCFullYear()}-${ist.getUTCMonth()}-${ist.getUTCDate()}`;
    const bucket = byDay.get(key) ?? [];
    if (bucket.length < 2) bucket.push(slot);
    byDay.set(key, bucket);
  }
  const result: { start: Date; end: Date }[] = [];
  for (const bucket of byDay.values()) {
    result.push(...bucket);
    if (result.length >= 6) break;
  }
  return result.slice(0, 6);
}

export async function getAvailableSlots(): Promise<Slot[]> {
  try {
    const auth = getAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const now = new Date();
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Check free/busy on primary calendar
    const freeBusy = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: nextWeek.toISOString(),
        timeZone: "Asia/Kolkata",
        items: [{ id: "primary" }],
      },
    });

    const busySlots = freeBusy.data.calendars?.primary?.busy ?? [];

    // Generate all possible 30-min slots
    const allSlots = generateSlots(now, nextWeek);

    // Filter out busy ones
    const freeSlots = allSlots.filter((slot) => {
      return !busySlots.some((busy) => {
        const busyStart = new Date(busy.start!).getTime();
        const busyEnd = new Date(busy.end!).getTime();
        return slot.start.getTime() < busyEnd && slot.end.getTime() > busyStart;
      });
    });

    return pickVariedSlots(freeSlots).map((s) => ({
      start: s.start.toISOString(),
      end: s.end.toISOString(),
    }));
  } catch (e) {
    console.error("Google Calendar getAvailableSlots error:", e);
    return [];
  }
}

export async function createBooking(
  name: string,
  email: string,
  slot: Slot
): Promise<{ success: boolean; message: string }> {
  try {
    const auth = getAuth();
    const calendar = google.calendar({ version: "v3", auth });

    await calendar.events.insert({
      calendarId: "primary",
      sendUpdates: "all", // sends confirmation email to attendee
      requestBody: {
        summary: `Interview with ${name}`,
        description: `30-minute interview call with ${name} (${email}) and Vinay Kumar Chopra`,
        start: {
          dateTime: slot.start,
          timeZone: "Asia/Kolkata",
        },
        end: {
          dateTime: slot.end,
          timeZone: "Asia/Kolkata",
        },
        attendees: [
          { email: "chopravinaykumarchopra@gmail.com", displayName: "Vinay Kumar Chopra" },
          { email, displayName: name },
        ],
        conferenceData: {
          createRequest: {
            requestId: `meet-${Date.now()}`,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      },
      conferenceDataVersion: 1,
    });

    return {
      success: true,
      message: `✅ Booked! A calendar invite has been sent to ${email} with a Google Meet link.`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Google Calendar createBooking error:", msg);
    return { success: false, message: `Booking failed: ${msg}` };
  }
}

export function formatSlots(slots: Slot[]): string {
  if (slots.length === 0) return "No available slots found in the next 7 days.";
  return slots
    .map((s, i) => {
      const d = new Date(s.start);
      return `${i + 1}. ${d.toLocaleDateString("en-IN", { weekday: "long", month: "short", day: "numeric" })} at ${d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST`;
    })
    .join("\n");
}
