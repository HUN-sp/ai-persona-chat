/**
 * Deterministic intent classifier for the chat assistant.
 *
 * This module answers one question: "What kind of message is this?"
 * It uses ZERO LLM calls — pure string matching and heuristics.
 *
 * Design rules (see tests/fixtures/router-cases.ts for the labelled set):
 *   - everything matches on WORD boundaries ("book" must not fire on "Facebook",
 *     "api" must not rescue "capital", "rest" must not rescue "restaurant");
 *   - a wrongly *blocked or hijacked* legitimate message is worse than an
 *     off-topic message that slips through to the LLM (whose system prompt
 *     still deflects it), so the guards are conservative;
 *   - inside the booking flow, an email address is always the answer.
 */

import type { BookingStep } from "./config";
import { extractEmail } from "./email";

// ── Intent type ─────────────────────────────────────────────────

export type Intent =
  | "cancel"         // User wants to exit booking flow
  | "booking_start"  // User wants to start booking (or restart from awaiting_email)
  | "booking_continue" // User is in an active booking flow
  | "off_topic"      // Message is clearly unrelated to Vinay
  | "chat";          // Default: RAG-grounded conversation

// ── Text normalization ──────────────────────────────────────────

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/(.)\1{2,}/g, "$1")     // noooo → no
    .replace(/\bdont\b/g, "don't")
    .replace(/\bwont\b/g, "won't")
    .replace(/\bcant\b/g, "can't")
    .replace(/\bdoesnt\b/g, "doesn't")
    .replace(/\bisnt\b/g, "isn't")
    .replace(/\bwasnt\b/g, "wasn't")
    .replace(/\bwouldnt\b/g, "wouldn't")
    .replace(/\bim\b/g, "i'm");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word/phrase match: not preceded/followed by a letter, digit, @ or dot-joined word char. */
function hasPhrase(text: string, phrase: string): boolean {
  return new RegExp(`(?<![a-z0-9@'])${escapeRegExp(phrase)}(?![a-z0-9@'])`).test(text);
}

/** Remove email addresses so words inside them ("skipper@…", "bookworm@…") are not read as intent. */
function stripEmails(text: string): string {
  return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, " ");
}

// ── Cancel detection ────────────────────────────────────────────

const STANDALONE_NEGATIVES = new Set([
  "no", "nah", "nope", "never", "stop", "exit", "quit", "bye",
]);

/** Unambiguous: cancels wherever they appear. */
const HARD_CANCEL_PHRASES = [
  "cancel", "nevermind", "never mind", "forget it", "forget about it",
  "goodbye", "good bye", "abort", "back out",
  "changed my mind", "i changed my mind",
  "don't book", "won't book", "can't book",
];

/** Cancel only when no day/time is being discussed ("I don't want mornings" is a preference). */
const SOFT_CANCEL_PHRASES = [
  "don't want", "don't need", "i don't want", "i don't need",
  "not interested", "not now", "not anymore",
  "no thanks", "no thank you", "not in the mood",
];

/** Cancel only when they are (almost) the whole message: "I'm good with Tuesday" isn't a cancel. */
const SHORT_ONLY_CANCEL_PHRASES = ["i'm good", "skip", "drop it", "leave it"];

const SCHEDULING_TOKEN =
  /\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:tomorrow|today|mornings?|afternoons?|evenings?|noon)\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/;

// Words that are allowed alongside negatives in short messages
const FILLER_WORDS = new Set([
  "i", "i'm", "just", "please", "ok", "okay",
]);

/**
 * Check if user wants to cancel/exit the current booking flow.
 * Only meaningful when bookingStep !== "idle".
 */
export function isCancelIntent(message: string, bookingStep: BookingStep): boolean {
  if (bookingStep === "idle") return false;

  const normalized = normalizeText(stripEmails(message));
  // While we are waiting for an email and the message carries one, only an explicit
  // cancel counts ("Skip Johnson, skip.j@x.com" is a name + address, not "skip").
  const answeringWithEmail = bookingStep === "awaiting_email" && extractEmail(message) !== null;

  if (answeringWithEmail) return HARD_CANCEL_PHRASES.some((p) => hasPhrase(normalized, p));

  // 1. Short message that's purely negative words (possibly with filler)
  //    e.g. "no", "nope", "i quit", "just stop", "noooo" (→ "no")
  const cleanWords = normalized
    .replace(/[^a-z'\s]/g, "")          // strip punctuation
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (cleanWords.length > 0 && cleanWords.length <= 3) {
    const allNegativeOrFiller = cleanWords.every(
      (w) => STANDALONE_NEGATIVES.has(w) || FILLER_WORDS.has(w)
    );
    const hasSomeNegative = cleanWords.some((w) => STANDALONE_NEGATIVES.has(w));
    if (allNegativeOrFiller && hasSomeNegative) {
      return true;
    }
  }

  // 2. Phrase-based cancel signals
  if (HARD_CANCEL_PHRASES.some((p) => hasPhrase(normalized, p))) return true;
  if (!SCHEDULING_TOKEN.test(normalized) && SOFT_CANCEL_PHRASES.some((p) => hasPhrase(normalized, p))) return true;
  return cleanWords.length <= 3 && SHORT_ONLY_CANCEL_PHRASES.some((p) => hasPhrase(normalized, p));
}

// ── Booking intent detection ────────────────────────────────────

const BOOKING_WORD_RE = /\b(?:book|booked|booking|schedule|scheduled|availability|available|meeting|meetings|interview|interviews|slot|slots)\b/;

// Contexts that contain a booking word but are about something else:
// the "Book-Author Relation" project, Facebook/notebook, a scheduler you built,
// interview *experience*, … They never start the booking flow.
const NOT_BOOKING_CONTEXT: RegExp[] = [
  /\bbook[- ]author\b/,
  /\b(?:interview|meeting)s? (?:experience|prep|preparation|questions?|process|skills?)\b/,
  /\bexperience (?:with|in|of) (?:interview|meeting)s?\b/,
  /\b(?:schedul(?:er|ers|ing algorithm)|book ?keeping|bookmarks?)\b/,
];

/** "I need a different time" while we are waiting for an email = pick again. */
const CHANGE_SLOT_RE = /\b(?:different|another|other|change|reschedule)\s+(?:the\s+)?(?:time|day|slot|date)\b/;

/**
 * Check if user wants to book/schedule a meeting.
 * (Whole-word: "Facebook", "notebook", "scheduler" no longer trigger it.)
 */
export function isBookingIntent(message: string): boolean {
  const lower = stripEmails(message).toLowerCase();
  if (NOT_BOOKING_CONTEXT.some((re) => re.test(lower))) return false;
  return BOOKING_WORD_RE.test(lower);
}

// ── Off-topic detection ─────────────────────────────────────────

/**
 * Words/phrases that make a message about Vinay's professional profile.
 * Whole-word matched. Deliberately NOT included: "you", "your", "name",
 * "work", "tool", "language", "number", "rest" – they appear in nearly every
 * sentence and used to switch the guard off entirely.
 */
const PROFESSIONAL_PHRASES = [
  // Identity
  "vinay", "vinay's", "chopra", "yourself", "introduce", "about you", "who are you",
  // Professional
  "project", "projects", "github", "repo", "repos", "repository", "code", "coding", "skill", "skills",
  "experience", "education", "bits", "pilani", "scaler", "hire", "hiring", "role", "intern", "internship",
  "job", "background", "portfolio", "achievement", "achievements", "qualification", "strength",
  "strengths", "weakness", "weaknesses", "tech stack", "technology", "technologies", "framework",
  "frameworks", "programming", "language", "languages", "software", "engineer", "engineering",
  "developer", "development", "backend", "frontend", "full stack", "database", "algorithm",
  "architecture", "system", "app", "application", "built", "build", "built", "developed", "deploy",
  "cloud", "hackathon", "college", "university", "degree", "certification", "linkedin", "cv", "resume",
  "cgpa", "gpa", "grade", "grades", "salary", "relocation", "notice period", "availability",
  // Specific tech
  "java", "python", "c++", "spring", "hft", "market data", "flask", "django", "hibernate", "jpa",
  "concurrency", "socket", "sockets", "tcp", "udp", "docker", "kubernetes", "git", "api", "apis",
  "rest api", "sql", "pandas", "jupyter", "machine learning", "ml", "ai", "llm",
  // Specific projects
  "data publisher", "product service", "aadhar", "aadhaar", "blood report", "flipkart", "parking",
  "atm", "snake and ladder", "music player", "microservice", "microservices", "book-author",
  "guppy", "persona",
  // Open source
  "open source", "open-source", "grass", "grass gis", "storacha", "pr#", "pull request", "contribution",
  "contributions", "contributed",
  // Contact
  "contact", "email", "phone", "reach you",
];

const PROFESSIONAL_RE = new RegExp(
  `(?<![a-z0-9])(?:${PROFESSIONAL_PHRASES.map(escapeRegExp).join("|")})(?![a-z0-9])`,
);
// "worked at/on/with…", "work experience" – an experience question even without other keywords
// "any disease prediction work?" / "your previous work" – "work" used as a noun about what was done
const WORK_CONTEXT_RE =
  /\bwork(?:ed|ing)?\s+(?:at|on|with|as|for|in|experience)\b|\b(?:any|your|his|related|relevant|similar|previous|prior|past|other)\s+(?:[\w-]+\s+){0,3}work\b|\bwork\s*[?.!]*$/;

const OFF_TOPIC_PATTERNS: RegExp[] = [
  // General knowledge / travel / how-to (not about Vinay)
  /\bhow (?:can|do|to|should|would) (?:i|we|one|someone) (?:go|get|travel|visit|cook|make|find|buy|sell|fix|solve)\b/,
  /\bwhat(?:'s| is) the (?:capital|population|distance|price|cost|weather|temperature|time in)\b/,
  /\bwhere (?:is|are|can|should)\b(?!.*(?:vinay|you|your|repo|project|github|code|skill))/,
  // Food / cooking
  /\b(recipe|cooking|cook|food|restaurants?|pizza|burger|biryani|dinner|lunch|breakfast|cafe|cuisine)\b/,
  // Weather
  /\b(weather|temperature|rain|forecast|climate|humidity|sunny|cloudy)\b/,
  // Entertainment & sport
  /\b(movies?|films?|series|netflix|amazon prime|sports?|cricket\w*|football\w*|ipl|nba|bollywood|web series|tv show|anime|manga)\b/,
  // Politics
  /\b(politic\w*|election\w*|government|prime minister|president|modi|trump|biden|parliament|congress|bjp|democrat\w*|republican\w*)\b/,
  // Personal / relationships
  /\b(girlfriend|boyfriend|marriage|romantic|dating|love life|wife|husband|crush|propose|relationship)\b/,
  // Religion
  /\b(religion|god|temple|mosque|church|prayer|spiritual|astrology|horoscope|zodiac)\b/,
  // Finance (non-tech)
  /\b(stock market|crypto|bitcoin|ethereum|nft|trading|investment tip|mutual fund|share price)\b/,
  // Jokes / entertainment / creative writing
  /\b(joke|meme|funny|roast|entertainment|bored|riddle|poem|poetry|lyrics|limerick|haiku)\b/,
  /\bwrite (?:me )?(?:a|an) (?:story|song|essay|joke)\b/,
  // Travel / tourism
  /\b(tourist|vacation|holiday|trip to|flight to|hotel in|places to visit)\b/,
  // Health
  /\b(doctor|hospital|medicine|treatment|symptom|disease|health tip|diagnosis)\b/,
  // Shopping
  /\b(buy|purchase|shopping|discount|coupon|offer|deal|where can i get)\b/,
  // Geography / directions
  /\b(how to go|directions to|route to|distance between|map of)\b/,
];

/**
 * Check if message is clearly off-topic (not about Vinay's professional profile).
 * Conservative: true only when an off-topic pattern matches AND there is no
 * professional signal at all.
 */
export function isOffTopic(message: string): boolean {
  const lower = message.toLowerCase().trim();

  // Short messages (greetings, acknowledgments) always pass through
  if (lower.split(/\s+/).length <= 3) return false;

  // Any professional signal → on-topic
  if (PROFESSIONAL_RE.test(lower) || WORK_CONTEXT_RE.test(lower)) return false;

  return OFF_TOPIC_PATTERNS.some((p) => p.test(lower));
}

// ── Main classifier ─────────────────────────────────────────────

/**
 * Deterministic intent classifier. This is the SINGLE entry point for routing.
 *
 * Priority:
 * 1. Cancel  (highest — user wants out of booking)
 * 2. Booking start  (when idle + booking keywords, or restart from awaiting_email)
 * 3. Booking continue  (in active booking flow; an email in awaiting_email is always the answer)
 * 4. Off-topic  (clearly unrelated to Vinay)
 * 5. Chat  (default — RAG-grounded conversation)
 */
export function classifyIntent(message: string, bookingStep: BookingStep): Intent {
  // 1. Cancel takes highest priority during active booking
  if (isCancelIntent(message, bookingStep)) {
    return "cancel";
  }

  // 2. Active booking flow
  if (bookingStep !== "idle") {
    // In awaiting_email, a message carrying an address IS the answer – even if the
    // address/name contains words like "book" or "interview" (bookworm@…).
    if (bookingStep === "awaiting_email" && extractEmail(message) !== null) {
      return "booking_continue";
    }
    // Special: if in awaiting_email and user says booking-related words,
    // they probably want to restart/re-pick rather than provide email
    if (bookingStep === "awaiting_email" && (isBookingIntent(message) || CHANGE_SLOT_RE.test(message.toLowerCase()))) {
      return "booking_start";
    }
    return "booking_continue";
  }

  // 3. Booking intent when idle
  if (isBookingIntent(message)) {
    return "booking_start";
  }

  // 4. Off-topic guard
  if (isOffTopic(message)) {
    return "off_topic";
  }

  // 5. Default: RAG chat
  return "chat";
}
