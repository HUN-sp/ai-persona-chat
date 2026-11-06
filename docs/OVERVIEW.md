# Architecture overview

_Written in Phase 0 from a read of every file in `app/` and `lib/`. Line numbers refer to the code at the start of the engagement (commit `45bbddc`); later fixes move them._

Next.js **16.2.3** (App Router, Turbopack), React 19, Tailwind v4. Next 16 has breaking changes; the route handlers here use only the standard Web `Request`/`Response` API (see `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`). `instrumentation.ts` is the Next 16 startup hook.

## Files

| Path | Role |
|---|---|
| `app/page.tsx` | Single client page: chat UI, booking quick-button, Vapi voice widget. Holds **all booking state in React state** and sends it with every request. |
| `app/api/chat/route.ts` | Chat endpoint. Parses body, classifies intent (`lib/router.ts`), dispatches to booking state machine or RAG+Groq. Also sniffs Vapi payloads and delegates to the webhook. |
| `app/api/vapi/webhook/route.ts` | Vapi tool-call handler: `searchVinayBackground`, `getAvailableSlots`, `createBooking`. Contains spoken-email normalisation and voice slot selection. |
| `app/api/init/route.ts` | Warm-up GET; calls `buildIndex()`. |
| `instrumentation.ts` | Calls `buildIndex()` at server start (just assigns the statically imported JSON). |
| `lib/router.ts` | Deterministic keyword intent classifier: `cancel`, `booking_start`, `booking_continue`, `off_topic`, `chat`. |
| `lib/booking.ts` | Booking state machine `idle → day_shown → slots_shown → awaiting_email → idle`, with natural-language day/time/email parsing. |
| `lib/calendar.ts` | Google Calendar: slot generation (IST, weekdays, 08:00–18:30, 30 min), `freebusy` query, `events.insert` with Meet link. |
| `lib/retriever.ts` | Cohere embed → (Pinecone ANN **or** in-memory cosine over `data/index.json`) → Cohere rerank → top-5 text joined by `---`. |
| `lib/vector-db.ts` | Pinecone wrapper (`vinay-persona` index, 1024-d cosine). Nothing in the repo calls `upsertChunks`. |
| `lib/indexer.ts` | Exposes the in-memory index. Loads the statically imported `data/index.json`; the "build dynamically" branch (GitHub + Cohere) is unreachable in practice. |
| `lib/github.ts`, `lib/resume.ts` | Index-time chunk producers (GitHub REST API; `data/resume.txt` split on ALL-CAPS headings). |
| `lib/persona.ts`, `lib/config.ts` | System prompt, owner contact constants, shared types. |
| `data/resume.txt` | Source-of-truth resume text. |
| `data/index.json` | Pre-built index: 198 chunks (7 resume, 191 GitHub), 1024-d Cohere embeddings, 2.8 MB. |

## Chat data flow

```
Browser (app/page.tsx)
  POST /api/chat { messages[], bookingStep, allSlots, pendingSlots, selectedSlot, slotPage }
        │
        ▼
route.ts: is body a Vapi payload? ──yes──► webhook POST (see Voice)
        │ no
        ▼
classifyIntent(lastMsg, bookingStep)            (lib/router.ts, no LLM)
  ├─ cancel            → handleCancel()                       → idle state
  ├─ booking_start     → getAvailableSlots() [Google freebusy] → day_shown + slots in response
  ├─ booking_continue  → handleBookingContinue()
  │                       ├─ handled      → next booking state
  │                       └─ not_booking  → RAG answer + booking reminder, state preserved
  ├─ off_topic         → canned deflection
  └─ chat              → generateRagAnswer()
                          1. retrieve(lastMsg, 5)   Cohere embed → Pinecone|memory → Cohere rerank
                          2. system = SYSTEM_PROMPT + "RELEVANT CONTEXT" (retrieved text)
                          3. Groq chat.completions (llama-3.3-70b-versatile, max_tokens 1024)
        │
        ▼
JSON { reply, bookingStep, allSlots, pendingSlots, selectedSlot, slotPage }
```

Per chat message: 1 Cohere embed, 1 Cohere rerank, 0–1 Pinecone query, 1 Groq call. Booking-start: 1 Google OAuth refresh + 1 `freebusy`. Booking-confirm: OAuth + 1 `events.insert`.

## Booking data flow (chat)

1. User clicks **Book a Call** → client sends the literal message `"I'd like to book a call with Vinay"` → `booking_start`.
2. Server lists ~2 weeks of free slots (`getAvailableSlots`) and replies with a per-day summary. **The full slot list is returned to the client** (`allSlots`, `pendingSlots`).
3. Client echoes that state back each turn. Day pick → `slots_shown` (times for that day). Time pick → `awaiting_email` with `selectedSlot`.
4. Message containing an email → `createBooking(name, email, selectedSlot)` → `events.insert` (sendUpdates=all, Meet link) → reply with the result → `idle`.

## Voice data flow

Browser uses `@vapi-ai/web` with a hard-coded public key + assistant id (`app/page.tsx:7-8`). Vapi runs STT/LLM/TTS itself and POSTs tool calls to the **Server URL** configured in the Vapi dashboard (`/api/vapi/webhook`, or `/api/chat`, which forwards).

- `searchVinayBackground(query)` → same `retrieve()` as chat; returns raw chunks to Vapi's LLM.
- `getAvailableSlots()` → Google freebusy → `selectVoiceSlots` (09:00–17:00 IST, ≤4/day, ≤3 days) → text with `slotTime=<ISO>` refs.
- `createBooking(name, email, slotTime)` → normalises the spoken email → `createBooking()`.

The webhook is **stateless**: the LLM carries the chosen `slotTime` between calls.

## Where state lives

| State | Location | Trust |
|---|---|---|
| Conversation history | Browser React state (`messages`), resent in full each request | untrusted |
| Booking step, slots, selected slot | Browser React state, echoed in request body | untrusted (server re-validates since Phase 2) |
| RAG index (embeddings) | `data/index.json` bundled into server chunks; cached on `globalThis.__ragIndex` | trusted |
| Vector store | Pinecone `vinay-persona` (optional, if `PINECONE_API_KEY`) | trusted; must be populated out-of-band |
| Calendar availability / bookings | Google Calendar (primary calendar of the OAuth user) — the only durable store | trusted |
| Voice session | Vapi (conversation) — the webhook keeps nothing | n/a |
| Secrets | Vercel env vars (`GROQ_API_KEY`, `COHERE_API_KEY`, `PINECONE_API_KEY`, `GOOGLE_*`, `GITHUB_TOKEN`) | — |

There is no database, no cookie, no session and no auth in the app.
