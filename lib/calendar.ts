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

// Generate 30-min slots between 9am-6pm IST on weekdays
function generateSlots(startDate: Date, endDate: Date): { start: Date; end: Date }[] {
  const slots = [];
  const current = new Date(startDate);

  while (current < endDate) {
    const day = current.getDay(); // 0=Sun, 6=Sat
    if (day !== 0 && day !== 6) {
      // Working hours: 9am to 6pm IST (UTC+5:30 = UTC+330min)
      for (let hour = 9; hour < 18; hour++) {
        for (const min of [0, 30]) {
          const slotStart = new Date(current);
          // Set to IST time by adjusting
          slotStart.setUTCHours(hour - 5, min - 30, 0, 0);
          if (slotStart.getUTCMinutes() < 0) {
            slotStart.setUTCHours(slotStart.getUTCHours() - 1, 30, 0, 0);
          }
          const slotEnd = new Date(slotStart.getTime() + 30 * 60000);
          if (slotStart > new Date()) {
            slots.push({ start: slotStart, end: slotEnd });
          }
        }
      }
    }
    current.setDate(current.getDate() + 1);
  }
  return slots;
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

    return freeSlots.slice(0, 6).map((s) => ({
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
