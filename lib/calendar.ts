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

// Generate 30-min slots 9am–5:30pm IST on weekdays over the given range
function generateSlots(startDate: Date, endDate: Date): { start: Date; end: Date }[] {
  const slots: { start: Date; end: Date }[] = [];

  const istStart = new Date(startDate.getTime() + IST_OFFSET_MS);
  const baseYear = istStart.getUTCFullYear();
  const baseMonth = istStart.getUTCMonth();
  const baseDay = istStart.getUTCDate();

  const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));

  for (let d = 0; d <= totalDays; d++) {
    const istDateMs = Date.UTC(baseYear, baseMonth, baseDay + d);
    if (new Date(istDateMs).getUTCDay() % 6 === 0) continue; // skip Sun(0) and Sat(6)

    for (let hour = 9; hour < 18; hour++) {
      for (const min of [0, 30]) {
        const istSlotMs = Date.UTC(baseYear, baseMonth, baseDay + d, hour, min, 0);
        const slotStart = new Date(istSlotMs - IST_OFFSET_MS);
        const slotEnd = new Date(slotStart.getTime() + 30 * 60_000);

        if (slotStart > startDate && slotStart < endDate) {
          slots.push({ start: slotStart, end: slotEnd });
        }
      }
    }
  }
  return slots;
}

// Returns up to maxSlots free slots chronologically (no day-grouping)
export async function getAvailableSlots(maxSlots = 15): Promise<Slot[]> {
  try {
    const auth = getAuth();
    const calendar = google.calendar({ version: "v3", auth });

    const now = new Date();
    // Look 2 weeks ahead so we have plenty of slots to paginate through
    const twoWeeks = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const freeBusy = await calendar.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: twoWeeks.toISOString(),
        timeZone: "Asia/Kolkata",
        items: [{ id: "primary" }],
      },
    });

    const busySlots = freeBusy.data.calendars?.primary?.busy ?? [];
    const allSlots = generateSlots(now, twoWeeks);

    const freeSlots = allSlots.filter((slot) => {
      return !busySlots.some((busy) => {
        const busyStart = new Date(busy.start!).getTime();
        const busyEnd = new Date(busy.end!).getTime();
        return slot.start.getTime() < busyEnd && slot.end.getTime() > busyStart;
      });
    });

    // Return chronological free slots up to maxSlots
    return freeSlots.slice(0, maxSlots).map((s) => ({
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
      sendUpdates: "all",
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
  if (slots.length === 0) return "No available slots found in the next 2 weeks.";
  return slots
    .map((s, i) => {
      const d = new Date(s.start);
      return `${i + 1}. ${d.toLocaleDateString("en-IN", { weekday: "long", month: "short", day: "numeric" })} at ${d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST`;
    })
    .join("\n");
}
