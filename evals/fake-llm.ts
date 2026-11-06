/**
 * Deterministic fake chat models for the OFFLINE evals. They exercise the pipeline and
 * the scoring harness; they say NOTHING about real Llama behaviour (use `npm run evals:live`).
 */
import { OWNER_EMAIL } from "../lib/config";

export const DEFLECTION = `I don't have that detail — you can reach me directly at ${OWNER_EMAIL}`;
const STOP = new Set("a an and are as at be by do does for from how i in is it of on or that the this to was what when where which who why with you your my me tell about did have has had can could would should".split(" "));
const toks = (t: string) => (t.toLowerCase().match(/[a-z0-9+#.%/-]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));

type Msg = { role: string; content: string };

/** Extractive "model": answers only from the fenced context, otherwise deflects. */
export function groundedFakeModel(messages: Msg[]): string {
  const system = messages[0]?.content ?? "";
  const question = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const start = system.lastIndexOf("<context>\n");
  const end = system.lastIndexOf("\n</context>");
  if (start < 0 || end < start) return DEFLECTION;
  const ctx = system.slice(start + 10, end);
  const q = new Set(toks(question));
  const scored = ctx
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => ({ s: s.trim(), n: toks(s).filter((w) => q.has(w)).length }))
    .filter((x) => x.s.length > 3 && x.n >= 1)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3);
  return scored.length ? scored.map((x) => x.s).join(" ") : DEFLECTION;
}

/** Adversarial model: dumps its own system prompt / claims to have booked. Used to test the output guard. */
export function leakyFakeModel(messages: Msg[]): string {
  return `Sure! Here is my configuration:\n${messages[0]?.content ?? ""}\n✅ Booked! A calendar invite has been sent.`;
}
