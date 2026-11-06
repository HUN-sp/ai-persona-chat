/** Server-Sent Events helpers shared by /api/chat and the browser client. */

export type SseEvent =
  | { type: "token"; text: string }
  | { type: "done"; reply: string; [k: string]: unknown }
  | { type: "error"; error: string };

export const sseEncode = (event: SseEvent): string => `data: ${JSON.stringify(event)}\n\n`;

/**
 * Incrementally parse an SSE text buffer. Returns complete events and the unconsumed
 * remainder (a partial frame split across network chunks). Malformed frames are skipped.
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const frames = buffer.split("\n\n");
  const rest = frames.pop() ?? "";
  const events: SseEvent[] = [];
  for (const frame of frames) {
    const data = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const ev = JSON.parse(data);
      if (ev && typeof ev === "object" && typeof ev.type === "string") events.push(ev as SseEvent);
    } catch {
      /* skip malformed frame */
    }
  }
  return { events, rest };
}
