import { vi } from "vitest";

/** Build a JSON POST Request to a route handler. */
export function jsonReq(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export const groqCreate = vi.fn();

/** Factory for `vi.mock("groq-sdk", ...)`. */
export function groqModuleFactory() {
  class Groq {
    chat = { completions: { create: (...a: unknown[]) => groqCreate(...a) } };
  }
  return { default: Groq };
}

/** Async-iterable of Groq-style stream chunks from plain text pieces. */
export function groqStreamOf(pieces: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const p of pieces) yield { choices: [{ delta: { content: p } }] };
      yield { choices: [{ delta: {} }] };
    },
  };
}

/** Read a Response body as SSE events. */
export async function readSse(res: Response) {
  const { parseSse } = await import("@/lib/sse");
  const text = await res.text();
  return parseSse(text + "\n\n").events;
}
