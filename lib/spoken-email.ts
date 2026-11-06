import { isValidEmail } from "./email";

/**
 * Turn a speech-to-text email into a real address, or null if it can't be one.
 *
 *   "vinay chopra three sixty at gmail dot com"  → vinaychopra360@gmail.com
 *   "alice twenty one at the rate example dot org" → alice21@example.org
 *   "bob underscore smith dash jr at x dot io"   → bob_smith-jr@x.io
 *   "jo double zero seven at x dot com"          → jo007@x.com
 *
 * Already-typed addresses ("a@b.com") pass through untouched.
 */

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SYMBOLS: Record<string, string> = {
  dot: ".", period: ".",
  underscore: "_", dash: "-", hyphen: "-", minus: "-", plus: "+",
};

export function normalizeSpokenEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.toLowerCase().trim();
  if (s.length === 0 || s.length > 300) return null;

  s = s.replace(/\bat\s+the\s+rate(?:\s+of)?\b/g, " @ ").replace(/\bthe\s+rate\b/g, " @ ");
  const tokens = s.split(/[\s,;]+/).filter(Boolean);
  const hasAtSymbol = tokens.some((t) => t.includes("@"));

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];

    if ((t === "double" || t === "triple") && next) {
      const times = t === "double" ? 2 : 3;
      const unit = next in ONES ? String(ONES[next]) : next.length === 1 ? next : null;
      if (unit !== null) {
        out.push(unit.repeat(times));
        i++;
        continue;
      }
    }
    if (t === "at" && !hasAtSymbol) { out.push("@"); continue; }
    if (t in SYMBOLS) { out.push(SYMBOLS[t]); continue; }
    if (t in TENS) {
      if (next && next in ONES && ONES[next] > 0) {
        out.push(String(TENS[t] + ONES[next]));
        i++;
      } else {
        out.push(String(TENS[t]));
      }
      continue;
    }
    if (t in TEENS) { out.push(String(TEENS[t])); continue; }
    if (t in ONES) { out.push(String(ONES[t])); continue; }
    if (t === "hundred") { out.push("00"); continue; }
    out.push(t);
  }

  const email = out.join("").replace(/[.,;:!?]+$/, "");
  return isValidEmail(email) ? email : null;
}
