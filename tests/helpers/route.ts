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
