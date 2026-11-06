/**
 * In-memory fake of the parts of `googleapis` this app uses.
 * Tests must NEVER reach the real Google Calendar.
 *
 * Usage in a test file:
 *   vi.mock("googleapis", async () => (await import("./helpers/google-mock")).googleModuleFactory());
 */

export interface FakeEvent {
  start: string;
  end: string;
  attendees?: string[];
  summary?: string;
}

export const calendarState = {
  events: [] as FakeEvent[],
  busy: [] as { start: string; end: string }[], // pre-existing busy blocks
  insertCalls: 0,
  freebusyCalls: 0,
  failFreebusy: false,
  failInsert: false,
  /** artificial latency (ms) to widen race windows */
  latencyMs: 0,
  lastInsert: null as unknown,
  oauthClients: 0,
};

export function resetCalendar() {
  calendarState.events = [];
  calendarState.busy = [];
  calendarState.insertCalls = 0;
  calendarState.freebusyCalls = 0;
  calendarState.failFreebusy = false;
  calendarState.failInsert = false;
  calendarState.latencyMs = 0;
  calendarState.lastInsert = null;
  calendarState.oauthClients = 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function overlaps(a: { start: string; end: string }, minMs: number, maxMs: number) {
  return Date.parse(a.start) < maxMs && Date.parse(a.end) > minMs;
}

export function googleModuleFactory() {
  class OAuth2 {
    constructor() {
      calendarState.oauthClients++;
    }
    setCredentials() {}
  }
  const calendar = () => ({
    freebusy: {
      query: async ({ requestBody }: { requestBody: { timeMin: string; timeMax: string } }) => {
        calendarState.freebusyCalls++;
        if (calendarState.latencyMs) await sleep(calendarState.latencyMs);
        if (calendarState.failFreebusy) throw new Error("freebusy boom");
        const min = Date.parse(requestBody.timeMin);
        const max = Date.parse(requestBody.timeMax);
        const busy = [...calendarState.busy, ...calendarState.events].filter((e) => overlaps(e, min, max));
        return { data: { calendars: { primary: { busy } } } };
      },
    },
    events: {
      insert: async (arg: {
        requestBody: {
          start: { dateTime: string };
          end: { dateTime: string };
          attendees?: { email: string }[];
          summary?: string;
        };
      }) => {
        calendarState.insertCalls++;
        calendarState.lastInsert = arg;
        if (calendarState.latencyMs) await sleep(calendarState.latencyMs);
        if (calendarState.failInsert) throw new Error("insert boom: secret-internal-detail");
        calendarState.events.push({
          start: arg.requestBody.start.dateTime,
          end: arg.requestBody.end.dateTime,
          attendees: arg.requestBody.attendees?.map((a) => a.email),
          summary: arg.requestBody.summary,
        });
        return { data: { id: "evt_" + calendarState.insertCalls } };
      },
    },
  });
  return { google: { auth: { OAuth2 }, calendar } };
}

/** Monday 2030-03-04 08:30 IST (= 03:00Z): a stable "now" for slot tests. */
export const FIXED_NOW = new Date("2030-03-04T03:00:00.000Z");
