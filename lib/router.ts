/**
 * Deterministic intent classifier for the chat assistant.
 *
 * This module answers one question: "What kind of message is this?"
 * It uses ZERO LLM calls — pure string matching and heuristics.
 *
 * The route handler uses the returned intent to decide which handler to invoke.
 */

import type { BookingStep } from "./config";

// ── Intent type ─────────────────────────────────────────────────

export type Intent =
  | "cancel"         // User wants to exit booking flow
  | "booking_start"  // User wants to start booking (or restart from awaiting_email)
  | "booking_continue" // User is in an active booking flow
  | "off_topic"      // Message is clearly unrelated to Vinay
  | "chat";          // Default: RAG-grounded conversation

// ── Text normalization ──────────────────────────────────────────

/**
 * Normalize text for fuzzy matching:
 * - lowercase + trim
 * - collapse 3+ repeated chars (noooo → no, yesss → yes)
 * - normalize contractions without apostrophe (dont → don't)
 */
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

// ── Cancel detection ────────────────────────────────────────────

const STANDALONE_NEGATIVES = new Set([
  "no", "nah", "nope", "never", "stop", "exit", "quit", "bye",
]);

const CANCEL_PHRASES = [
  "cancel", "nevermind", "never mind", "forget it", "forget about it",
  "don't want", "don't book", "don't need",
  "not interested", "not now", "not anymore",
  "no thanks", "no thank you",
  "goodbye", "good bye", "leave it", "drop it",
  "i don't want", "i don't need",
  "won't book", "can't book", "skip",
  "changed my mind", "i changed my mind",
  "abort", "back out",
  "i'm good", "not in the mood",
];

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

  const normalized = normalizeText(message);

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
  return CANCEL_PHRASES.some((phrase) => normalized.includes(phrase));
}

// ── Booking intent detection ────────────────────────────────────

const BOOKING_KEYWORDS = [
  "book", "schedule", "availability", "available",
  "meeting", "interview", "slot",
];

/**
 * Check if user wants to book/schedule a meeting.
 */
export function isBookingIntent(message: string): boolean {
  const lower = message.toLowerCase();

  // "call" alone is ambiguous (could mean voice call), but with booking
  // context it's clearly a booking request
  if (lower.includes("call") && (lower.includes("book") || lower.includes("schedule"))) {
    return true;
  }

  return BOOKING_KEYWORDS.some((k) => lower.includes(k));
}

// ── Off-topic detection ─────────────────────────────────────────

// Professional keywords that indicate the message is about Vinay
const PROFESSIONAL_KEYWORDS = [
  // Identity
  "vinay", "you", "your", "yourself", "about you", "who are you", "introduce",
  // Professional
  "project", "github", "code", "skill", "experience", "education", "bits",
  "scaler", "hire", "role", "intern", "job", "background", "work", "portfolio",
  "achievement", "qualification", "strength", "weakness", "tech stack",
  "technology", "framework", "language", "tool",
  // Specific tech
  "java", "python", "c++", "spring", "hft", "market data", "flask", "django",
  "hibernate", "jpa", "concurrency", "socket", "tcp", "udp", "docker", "git",
  "api", "rest",
  // Specific projects
  "data publisher", "product service", "aadhar", "blood report", "flipkart",
  "parking", "atm", "snake", "music", "microservice", "book-author", "guppy",
  // Open source
  "open source", "grass", "storacha", "pr#", "pull request", "contribution",
  // Contact
  "contact", "email", "phone", "number", "reach", "name",
  // Resume
  "resume", "cgpa", "grade",
];

const OFF_TOPIC_PATTERNS: RegExp[] = [
  // General knowledge / travel / how-to (not about Vinay)
  /\bhow (?:can|do|to|should|would) (?:i|we|one|someone|you) (?:go|get|travel|reach|visit|cook|make|find|buy|sell|fix|solve)\b/,
  /\bwhat is the (?:capital|population|distance|price|cost|weather|temperature|time in)\b/,
  /\bwhere (?:is|are|can|should)\b(?!.*(?:vinay|you|your|repo|project|github|code|skill))/,
  // Food / cooking
  /\b(recipe|cooking|food|restaurant|pizza|burger|biryani|dinner|lunch|breakfast|cafe|cuisine)\b/,
  // Weather
  /\b(weather|temperature|rain|forecast|climate|humidity|sunny|cloudy)\b/,
  // Entertainment
  /\b(movie|film|series|netflix|amazon prime|sports?|cricket|football|ipl|nba|bollywood|web series|tv show|anime|manga)\b/,
  // Politics
  /\b(politic|election|government|prime minister|president|modi|trump|biden|parliament|congress|bjp|democrat|republican)\b/,
  // Personal / relationships
  /\b(girlfriend|boyfriend|marriage|romantic|dating|love life|wife|husband|crush|propose|relationship)\b/,
  // Religion
  /\b(religion|god|temple|mosque|church|prayer|spiritual|astrology|horoscope|zodiac)\b/,
  // Finance (non-tech)
  /\b(stock market|crypto|bitcoin|ethereum|nft|trading|investment tip|mutual fund|share price)\b/,
  // Jokes / entertainment
  /\b(joke|meme|funny|roast|entertainment|bored|riddle)\b/,
  // Travel / tourism
  /\b(tourist|vacation|holiday|trip to|flight to|hotel in|places to visit)\b/,
  // Health (non-blood-report-analyzer)
  /\b(doctor|hospital|medicine|treatment|symptom|disease|health tip|diagnosis)\b/,
  // Shopping (non-flipkart-clone context)
  /\b(buy|purchase|shopping|discount|coupon|offer|deal|where can i get)\b/,
  // Geography / directions
  /\b(how to go|directions to|route to|distance between|map of)\b/,
];

/**
 * Check if message is clearly off-topic (not about Vinay's professional profile).
 * Conservative: returns true only when confident.
 */
export function isOffTopic(message: string): boolean {
  const lower = message.toLowerCase().trim();

  // Short messages (greetings, acknowledgments) always pass through
  if (lower.split(/\s+/).length <= 3) return false;

  // If it mentions any professional keyword, it's on-topic
  if (PROFESSIONAL_KEYWORDS.some((k) => lower.includes(k))) return false;

  // Check against off-topic patterns
  return OFF_TOPIC_PATTERNS.some((p) => p.test(lower));
}

// ── Main classifier ─────────────────────────────────────────────

/**
 * Deterministic intent classifier. This is the SINGLE entry point for routing.
 *
 * Priority:
 * 1. Cancel  (highest — user wants out of booking)
 * 2. Booking start  (when idle + booking keywords, or restart from awaiting_email)
 * 3. Booking continue  (in active booking flow)
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
    // Special: if in awaiting_email and user says booking-related words,
    // they probably want to restart/re-pick rather than provide email
    if (bookingStep === "awaiting_email" && isBookingIntent(message)) {
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
