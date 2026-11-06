/**
 * Offline, deterministic measurements for docs/AUDIT.md (Phase 3). No network, no keys.
 *   npx tsx evals/measure.ts
 * Tokens are estimated as chars/4 (rough for English; the real Llama tokenizer differs by ±15%).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_PROMPT } from "../lib/persona";
import { parseMessages } from "../lib/chat-input";
import { generateSlotGrid, toSlot } from "../lib/slots";

const tok = (chars: number) => Math.round(chars / 4);
const index: { text: string; metadata: { source: string } }[] = JSON.parse(readFileSync(join(process.cwd(), "data", "index.json"), "utf-8"));
const lens = index.map((c) => c.text.length).sort((a, b) => b - a);

console.log("== Prompt tokens per chat request (estimate chars/4)");
console.log(`system prompt: ${SYSTEM_PROMPT.length} chars ≈ ${tok(SYSTEM_PROMPT.length)} tokens`);
const avgChunk = lens.reduce((a, b) => a + b, 0) / lens.length;
console.log(`context: 5 chunks; avg chunk ${Math.round(avgChunk)} chars → typical ${tok(avgChunk * 5)} tokens; worst case (5 largest) ${tok(lens.slice(0, 5).reduce((a, b) => a + b, 0))} tokens`);

console.log("\n== History sent to the LLM (40-turn conversation, 300-char messages)");
const turns = Array.from({ length: 80 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(300) }));
turns[turns.length - 1] = { role: "user", content: "last question here" };
const before = turns.reduce((a, m) => a + m.content.length, 0);
const parsed = parseMessages(turns);
const after = parsed.ok ? parsed.messages.reduce((a, m) => a + m.content.length, 0) : -1;
console.log(`before: ${turns.length} messages, ${before} chars ≈ ${tok(before)} tokens (grows without bound)`);
console.log(`after:  ${parsed.ok ? parsed.messages.length : 0} messages, ${after} chars ≈ ${tok(after)} tokens (capped)`);

console.log("\n== Booking payload (day-summary response; the same arrays are echoed back by the browser)");
const now = new Date("2030-03-04T03:00:00Z");
const slots = generateSlotGrid(now, new Date(now.getTime() + 14 * 86_400_000)).map((s) => toSlot(s.start.getTime()));
const bytes = JSON.stringify({ allSlots: slots, pendingSlots: slots, selectedSlot: null }).length;
console.log(`${slots.length} slots → ${(bytes / 1024).toFixed(1)} KB per response and per follow-up request`);
