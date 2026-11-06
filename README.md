# Vinay Kumar Chopra — AI Representative

An interactive AI persona: chat with it, call it, and book a real interview slot on Vinay's Google Calendar. Built for the Scaler School of Technology screening assignment.

**Live:** https://aipersonachat.vercel.app

- **Chat** – answers questions about education, skills, projects and open-source work, grounded in the resume and GitHub repos via RAG. Replies stream token by token.
- **Voice** – one-click voice call (Vapi) that uses the same knowledge base and the same calendar.
- **Booking** – shows real free slots (weekdays 08:00–18:30 IST, next 2 weeks), re-checks the calendar right before creating the event, and sends a Google Meet invite.

> Status of this README: it describes the code in this repository. Anything that needs real credentials (Groq, Cohere, Pinecone, Google, Vapi) is listed under [What I could not test](#what-i-could-not-test-without-real-keys).

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript, Tailwind v4 |
| LLM | Groq `llama-3.3-70b-versatile` |
| Retrieval | Cohere `embed-english-v3.0` + `rerank-english-v3.0`; Pinecone (optional) or in-memory cosine over `data/index.json` |
| Voice | Vapi (tool calls → `/api/vapi/webhook`) |
| Calendar | Google Calendar API v3 (OAuth2 refresh token) |
| Tests | Vitest (all external services mocked), offline eval harness, GitHub Actions CI |
| Hosting | **Vercel** |

## How it works

```
Browser ──POST /api/chat (JSON, Accept: text/event-stream)──► rate limit · size caps · validation
   │                                                           │
   │                              classifyIntent (no LLM) ◄────┘
   │            cancel │ booking_start │ booking_continue │ off_topic │ chat
   │                   ▼               ▼                  ▼           ▼         ▼
   │              canned reply   Google freebusy   state machine   canned    retrieve → Groq (SSE)
   ◄── JSON, or SSE: token… then done{reply, booking state} ─────────────────────────────────────
Vapi ──POST /api/vapi/webhook (X-Vapi-Secret)──► searchVinayBackground │ getAvailableSlots │ createBooking
                                                                                   │
                                  both booking paths ──► createBooking(): validate slot on grid ──►
                                       freebusy re-check under a per-slot lock ──► events.insert
```

Details, data flow and where state lives: [`docs/OVERVIEW.md`](docs/OVERVIEW.md). Findings and measurements: [`docs/AUDIT.md`](docs/AUDIT.md). What was changed and why: [`docs/PROGRESS.md`](docs/PROGRESS.md).

### Security model (short)

- Booking state sent by the browser is **untrusted**: slots are rebuilt server-side and must lie on the bookable grid; the calendar is re-checked immediately before every insert; only `slot.start` is used (event length is always 30 minutes).
- `/api/vapi/webhook` (and the `/api/chat` Vapi alias) require `VAPI_WEBHOOK_SECRET` once it is set.
- Per-IP rate limits, request size/message caps, bounded history, no CORS wildcard, no request bodies in logs, generic error messages.
- Retrieved text is fenced as untrusted data; the system prompt forbids disclosure; output guards swallow prompt leaks and fake booking confirmations; the chat UI renders no images or raw HTML.
- **Limitation:** rate limits are in-memory per serverless instance (best effort). See *Open risks* in `docs/PROGRESS.md`.

## Local setup

```bash
git clone https://github.com/HUN-sp/ai-persona-chat.git
cd ai-persona-chat
npm install
cp .env.example .env.local   # then fill in the values (see below)
npm run dev                  # http://localhost:3000
```

Without any keys the UI loads, routing/booking validation work, and `npm test` passes (everything is mocked). Chat answers need `GROQ_API_KEY` + `COHERE_API_KEY`; booking needs the three `GOOGLE_*` values.

### Environment variables

See [`.env.example`](.env.example) (no real values). Summary:

| Variable | Needed for | Notes |
|---|---|---|
| `GROQ_API_KEY` | chat | console.groq.com |
| `COHERE_API_KEY` (alias `CO_API_KEY`) | chat retrieval | dashboard.cohere.com |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | booking | mint the token with `npm run google-auth` |
| `VAPI_WEBHOOK_SECRET` | voice webhook auth | same value in Vapi; **unset = unauthenticated** (a warning is logged) |
| `PINECONE_API_KEY` | optional | enables Pinecone; unset = in-memory search |
| `GITHUB_TOKEN` | `npm run rebuild-index` only | raises GitHub API rate limit |
| `ALLOWED_ORIGINS` | optional | extra browser origins allowed to call the API |
| `PERSONA_ID`, `NEXT_PUBLIC_PERSONA_ID` | optional | select a persona folder (default `vinay`) |
| `NEXT_PUBLIC_VAPI_PUBLIC_KEY`, `NEXT_PUBLIC_VAPI_ASSISTANT_ID` | optional | override the Vapi ids from `persona/<id>/ui.json` (public by design) |
| `RATE_*`, `MAX_*`, `RAG_MIN_SCORE`, `GROQ_TEMPERATURE`, … | optional tuning | defaults in `lib/limits.ts`, `lib/retriever.ts`, `lib/config.ts` |

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run lint` · `npm run typecheck` | ESLint · `tsc --noEmit` |
| `npm test` | Vitest: unit + route tests + offline evals (no network) |
| `npm run evals` | Offline evals only → table + `evals/results/latest.md` |
| `npm run evals:live` | Same questions against **real** Groq + Cohere (needs keys; costs a few cents; not in CI) |
| `npm run google-auth` | Prints a `GOOGLE_REFRESH_TOKEN` after you approve access (nothing is written to disk) |
| `npm run rebuild-index` | Re-chunks `data/resume.txt` + your public GitHub repos, embeds with Cohere, overwrites `data/index.json` (**paid calls**; review the diff) |
| `npm run update-golden` | Regenerates the golden system-prompt snapshot after an *intentional* persona change |
| `npm run seed-pinecone` | Creates the `vinay-persona` index if needed and upserts `data/index.json` (no embedding calls) |

### Updating the knowledge base

1. Edit `data/resume.txt` (and, if you cite a fact in the prompt, `persona/vinay/persona.json` – a test fails if they disagree).
2. `npm run rebuild-index`, review the diff, commit `data/index.json`.
3. If you use Pinecone: `npm run seed-pinecone`.

Persona authoring (wording, facts, a different person): [`docs/PERSONA.md`](docs/PERSONA.md).

## Deployment (Vercel)

1. Import the repo in Vercel (framework preset: Next.js). Pushes to `main` deploy to production.
2. Set the environment variables above in *Project → Settings → Environment Variables* (Production, and Preview if you use it).
3. **Vapi** (app.vapi.ai → your assistant):
   - Server URL: `https://<your-domain>/api/vapi/webhook`
   - Server secret / bearer credential: the value of `VAPI_WEBHOOK_SECRET` (sent as `X-Vapi-Secret` or `Authorization: Bearer`).
   - Tools (exact names): `getAvailableSlots` (no params), `createBooking` (`name`, `email`, `slotTime` – the ISO string exactly as listed), `searchVinayBackground` (`query`).
4. Google OAuth client must list `http://localhost` as an authorised redirect URI (used by `npm run google-auth` and `lib/calendar.ts`).

## Testing

- `npm test` – ~290 tests, all offline: booking guard (race/tamper), router (79 labelled cases), webhook/auth, SSE, persona golden prompt, retriever caching, and the eval harness.
- CI (`.github/workflows/ci.yml`): lint → typecheck → tests + offline evals → build.
- The offline evals prove routing, prompt assembly, guards, booking flows and that every ground-truth fact is in the shipped index. They **cannot** judge real model answers; use `npm run evals:live`.

## Project structure

```
app/            page.tsx (UI), api/chat, api/vapi/webhook, api/init
lib/            booking.ts (state machine) · calendar.ts (guarded writes) · slots.ts (IST grid)
                booking-state.ts (untrusted-state sanitiser) · router.ts · retriever.ts · chat.ts
                vapi.ts · voice.ts · spoken-email.ts · http.ts · rate-limit.ts · limits.ts · sse.ts
persona/        template.ts (wording) · render.ts · vinay/{persona,ui}.json (facts, contact, UI copy)
data/           resume.txt (source of truth) · index.json (pre-built embeddings)
scripts/        rebuild-index.ts · upsert-pinecone.ts · google-auth.ts
tests/ evals/   Vitest suites · eval dataset, lexical proxy retriever, live runner
docs/           OVERVIEW · AUDIT · PROGRESS · PERSONA
```

## What I could not test without real keys

Nothing in this repository has been run against live Groq, Cohere, Pinecone, Google Calendar or Vapi. Specifically unverified: real answer quality at temperature 0.3; Cohere/Pinecone retrieval quality and the 0.25 score threshold on Pinecone; Google's behaviour for the freebusy→insert sequence and `sendUpdates`; Vapi's secret header name and tool-call payload shapes; SSE behaviour on Vercel's edge; the GitHub Actions run. Checklist in `docs/PROGRESS.md`.
