# Vinay Kumar Chopra — AI Representative

An interactive AI persona built as part of the Scaler School of Technology screening assignment. It lets anyone chat with or call an AI version of Vinay, ask about his background and projects, and book a real interview slot on his Google Calendar.

Live demo: https://meticulous-nature-production-cc87.up.railway.app

---

## What it does

- **Chat interface** — Ask anything about Vinay's skills, projects, education, and open-source work. Answers are grounded in his actual resume and GitHub repos via RAG.
- **Voice call** — One-click voice conversation powered by Vapi AI. Same knowledge base, spoken naturally.
- **Real calendar booking** — Checks Vinay's actual Google Calendar for free slots (8 AM–6:30 PM IST, weekdays), shows available days with slot counts, lets you pick a time, and creates a Google Meet event with an invite sent to both parties.

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS v4 |
| LLM | Groq — `llama-3.3-70b-versatile` |
| Embeddings | Cohere — `embed-english-v3.0` |
| Reranking | Cohere — `rerank-english-v3.0` |
| Voice agent | Vapi AI |
| Calendar | Google Calendar API v3 (OAuth2) |
| GitHub indexing | GitHub REST API |
| Resume parsing | `pdf-parse` + plain text |
| Deployment | Railway |

---

## Architecture

```
User message
    │
    ▼
Booking intent? ──yes──► Google Calendar freebusy API
    │                         └─► Show days + slot counts
    │                         └─► User picks day → times → name/email → create event
    │
    no
    ▼
RAG retrieval
    ├─ Cohere embed query
    ├─ Cosine similarity over pre-built index (GitHub repos + resume)
    ├─ Cohere rerank top candidates
    └─► Groq LLM with retrieved context → response

Voice call (Vapi)
    └─► Webhook at /api/vapi/webhook
        ├─ searchVinayBackground → same RAG pipeline
        ├─ getAvailableSlots → same Google Calendar check
        └─ createBooking → same Google Calendar event creation
```

### RAG index

Built once and saved to `data/index.json` (committed to the repo so Railway doesn't need to rebuild on cold start). Contains:

- Resume sections (parsed from `data/resume.txt`)
- Repo metadata for all public GitHub repos (HUN-sp)
- Source file chunks (top 5 files × first 15 repos, 80 lines per chunk)

---

## Local setup

### 1. Clone

```bash
git clone <your-repo-url>
cd chat-app
```

### 2. Install dependencies

```bash
npm install
```

### 3. Environment variables

Create `.env.local` in the `chat-app` root:

```env
# Groq — chat LLM
GROQ_API_KEY=your_groq_api_key

# Cohere — embeddings + reranking
COHERE_API_KEY=your_cohere_api_key

# GitHub — repo indexing (optional but recommended to avoid rate limits)
GITHUB_TOKEN=your_github_pat

# Google Calendar — OAuth2
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REFRESH_TOKEN=your_refresh_token

# Vapi — voice agent
VAPI_PUBLIC_KEY=your_vapi_public_key
```

Where to get each key:
- **GROQ_API_KEY** — console.groq.com
- **COHERE_API_KEY** — dashboard.cohere.com
- **GITHUB_TOKEN** — GitHub → Settings → Developer settings → Personal access tokens (read:public_repo scope)
- **Google OAuth** — see section below
- **VAPI_PUBLIC_KEY** — app.vapi.ai → your account

### 4. Google Calendar OAuth setup

If you need a fresh refresh token:

```bash
node scripts/google-auth.mjs
```

Follow the printed instructions — it will open a browser URL, you sign in with the calendar owner's Google account, paste the redirect code back, and it prints the three `GOOGLE_*` values to add to `.env.local`.

### 5. (Optional) Rebuild the RAG index

The pre-built `data/index.json` is already committed. Only run this if you've updated the resume or want to re-index GitHub:

```bash
node scripts/build-index.mjs
```

This fetches GitHub repos, embeds all chunks via Cohere, and overwrites `data/index.json`. Takes a few minutes on a fresh run due to API rate limits.

### 6. Run locally

```bash
npm run dev
```

Open http://localhost:3000.

---

## Project structure

```
chat-app/
├── app/
│   ├── page.tsx                  # Main chat + voice UI
│   └── api/
│       ├── chat/route.ts         # Chat API — booking flow + RAG chat
│       ├── init/route.ts         # Warm-up endpoint
│       └── vapi/webhook/route.ts # Vapi tool-call handler
├── lib/
│   ├── calendar.ts               # Google Calendar — free slot detection + booking
│   ├── retriever.ts              # RAG retrieval — embed + cosine + rerank
│   ├── indexer.ts                # RAG index builder (runtime)
│   ├── github.ts                 # GitHub API fetcher
│   ├── resume.ts                 # Resume text parser
│   └── persona.ts                # Persona constants
├── data/
│   ├── resume.txt                # Vinay's resume (plain text)
│   └── index.json                # Pre-built RAG index (embeddings)
└── scripts/
    ├── build-index.mjs           # Offline index builder
    └── google-auth.mjs           # Google OAuth refresh token helper
```

---

## Deployment (Railway)

1. Push this repo to GitHub.
2. Create a new Railway project → deploy from GitHub.
3. Add all 7 environment variables in Railway → your service → Variables:

```
GROQ_API_KEY
COHERE_API_KEY
CO_API_KEY          ← same value as COHERE_API_KEY (Cohere SDK v7+ alias)
GITHUB_TOKEN
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
VAPI_PUBLIC_KEY
```

4. Railway auto-deploys on every push to main.

### Vapi assistant configuration

In app.vapi.ai → your assistant:
- **Server URL**: `https://your-railway-url.up.railway.app/api/vapi/webhook`
- **Tools**: define three tools with these exact names and parameters:

| Tool | Parameters |
|---|---|
| `getAvailableSlots` | _(none)_ |
| `createBooking` | `name` (string), `email` (string), `slotTime` (ISO datetime string) |
| `searchVinayBackground` | `query` (string) |

---

## Key design decisions

- **Pre-built RAG index** — embedding at build time avoids cold-start latency and Cohere rate limits on every deploy.
- **Cohere reranking** — cosine similarity alone has poor precision; cross-encoder reranking gives significantly better context retrieval.
- **Google Calendar freebusy API** — instead of hardcoding availability, the app queries real busy/free intervals so the calendar stays the single source of truth.
- **Two-step booking flow** — showing days with slot counts first (instead of a flat time list) is much easier to navigate in a chat UI.
- **Stateless API** — all booking state (`bookingStep`, `allSlots`, `pendingSlots`, `selectedSlot`) lives client-side and is sent with each request, so the API is fully stateless.
