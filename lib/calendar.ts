export interface Slot {
  start: string;
  end: string;
  uri: string; // Calendly event type URI - needed for booking
}

const CALENDLY_BASE = "https://api.calendly.com";

function headers() {
  return {
    Authorization: `Bearer ${process.env.CALENDLY_API_KEY}`,
    "Content-Type": "application/json",
  };
}

// Cache user + event type URIs so we don't fetch them on every request
let cachedUserUri: string | null = null;
let cachedEventTypeUri: string | null = null;

async function getUserUri(): Promise<string | null> {
  if (cachedUserUri) return cachedUserUri;
  const res = await fetch(`${CALENDLY_BASE}/users/me`, { headers: headers() });
  if (!res.ok) {
    console.error("Calendly /users/me error:", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  cachedUserUri = data?.resource?.uri ?? null;
  console.log("Calendly user URI:", cachedUserUri);
  return cachedUserUri;
}

async function getEventTypeUri(): Promise<string | null> {
  if (cachedEventTypeUri) return cachedEventTypeUri;
  const userUri = await getUserUri();
  if (!userUri) return null;

  const res = await fetch(
    `${CALENDLY_BASE}/event_types?user=${encodeURIComponent(userUri)}&active=true`,
    { headers: headers() }
  );
  if (!res.ok) {
    console.error("Calendly event_types error:", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const types = data?.collection ?? [];
  console.log("Calendly event types:", types.map((t: { name: string; uri: string }) => t.name));

  // Prefer 30-min type
  const thirty = types.find((t: { name: string }) =>
    t.name.toLowerCase().includes("30")
  );
  cachedEventTypeUri = (thirty ?? types[0])?.uri ?? null;
  console.log("Using event type URI:", cachedEventTypeUri);
  return cachedEventTypeUri;
}

export async function getAvailableSlots(): Promise<Slot[]> {
  const eventTypeUri = await getEventTypeUri();
  if (!eventTypeUri) return [];

  const start = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
  const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const res = await fetch(
    `${CALENDLY_BASE}/event_type_available_times?event_type=${encodeURIComponent(eventTypeUri)}&start_time=${start}&end_time=${end}`,
    { headers: headers() }
  );
  if (!res.ok) {
    console.error("Calendly available_times error:", res.status, await res.text());
    return [];
  }

  const data = await res.json();
  console.log("Calendly available times count:", data?.collection?.length ?? 0);

  const times = data?.collection ?? [];
  return times.slice(0, 6).map((t: { start_time: string }) => ({
    start: t.start_time,
    end: new Date(new Date(t.start_time).getTime() + 30 * 60000).toISOString(),
    uri: eventTypeUri,
  }));
}

export async function createBooking(
  name: string,
  email: string,
  slot: Slot
): Promise<{ success: boolean; message: string }> {
  const eventTypeUri = await getEventTypeUri();
  if (!eventTypeUri) return { success: false, message: "Could not find event type." };

  // Calendly v2: create a booking for an invitee
  const res = await fetch(`${CALENDLY_BASE}/scheduled_events`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      event_type: eventTypeUri,
      start_time: slot.start,
      invitees: [{ email, name }],
    }),
  });

  const text = await res.text();
  console.log("Calendly create booking response:", res.status, text.slice(0, 500));

  if (!res.ok) {
    // Calendly API doesn't support direct booking creation on free plans
    // Fall back to pre-filled scheduling link
    const date = new Date(slot.start);
    const dateStr = date.toISOString().split("T")[0];
    const prefilledUrl = `https://calendly.com/chopravinaykumarchopra/30min?date=${dateStr}&name=${encodeURIComponent(name)}&email=${encodeURIComponent(email)}`;
    return {
      success: true,
      message: `Your details are ready! Click to confirm your booking:\n\n**[Confirm ${date.toLocaleDateString("en-IN", { weekday: "long", month: "short", day: "numeric" })} at ${date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} IST →](${prefilledUrl})**\n\nCalendly will send a confirmation email to ${email} once you confirm.`,
    };
  }

  return {
    success: true,
    message: `✅ Booked! Confirmation sent to ${email}.`,
  };
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
