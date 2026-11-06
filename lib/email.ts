/** Email helpers shared by the chat booking flow, the voice webhook and the calendar layer. */

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const EMAIL_IN_TEXT_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email);
}

/** First email address found in free text, or null. */
export function extractEmail(text: string): string | null {
  const m = text.match(EMAIL_IN_TEXT_RE);
  return m ? m[0] : null;
}
