# Audit (Phase 1)

Ranked list. **P0** security hole / data or privacy leak / double booking / crash. **P1** broken feature or demo-breaking. **P2** quality / UX. **P3** nice to have. Effort: **S** (< 1 h), **M** (a few hours), **L** (a day+).

Evidence is by file:line at commit `45bbddc` (before any fix) and was verified by reading the code and, where noted, by running it (no network, no keys). Each item gets an ID that the commit messages in `docs/PROGRESS.md` refer to.

Status column is updated as phases complete: ☐ open · ✅ fixed · ◐ partly fixed · ➜ flagged for owner.

## P0

| ID | Eff | Status | Finding | Evidence |
|---|---|---|---|---|
| **SEC-1** | S | ✅ | **Chat booking trusts the client's `selectedSlot`.** Anyone can POST `{bookingStep:"awaiting_email", selectedSlot:{start:"2099-01-01T00:00Z", end:"2099-01-02T00:00Z"}, messages:[{role:"user",content:"a@b.com"}]}` and the server calls `events.insert` for that arbitrary window (any hour, any day, weekend, past, multi-hour `end`) and emails an invite to any address. Also `allSlots`/`pendingSlots` are client-supplied, so steps can be skipped. | `app/api/chat/route.ts:113-118` (state read from body), `lib/booking.ts:539-547` (books `selectedSlot` as given). Reproduced with a tsx probe: with credentials absent the call reached `createBooking` with the 2099 slot. |
| **SEC-2** | S | ✅ | **Voice `createBooking` books any `slotTime`.** If the time isn't in the free list it fabricates a slot (`?? { start: targetMs, end: +30m }`), so any ISO string (past, 3 a.m., busy, year 2099) is booked with no availability check. | `app/api/vapi/webhook/route.ts:161-170` |
| **SEC-3** | M | ✅ | **No double-booking guard.** `createBooking` never re-checks freebusy and nothing serialises concurrent chat + voice bookings; the freebusy result used to show a slot can be minutes/hours old (it lives in the client). | `lib/calendar.ts:96-139` |
| **SEC-4** | S | ✅ | **Webhook is unauthenticated.** No shared-secret / bearer check. Anyone can invoke the three tools directly: spam-invite arbitrary emails from Vinay's Google account, burn Cohere/Pinecone quota via `searchVinayBackground`. `/api/chat` forwards anything that looks like a Vapi payload into the same handler (body sniffing at `route.ts:134-145`), so there are two public entry points. Sniffing is not an extra privilege (webhook is open anyway) but doubles the attack surface and parses the body twice. | `app/api/vapi/webhook/route.ts:197-240`, `app/api/chat/route.ts:126-145` |
| **SEC-5** | M | ✅ | **No rate limiting, no input caps, unbounded history, CORS `*`.** `messages` can be any length/size and every element is forwarded to Groq; `content` is not type-checked; any website can call the API from a browser. Direct cost-abuse path on Groq (+Cohere +Pinecone) and on the calendar. | `route.ts:104-118` (no checks), `route.ts:35-45` & `webhook/route.ts:184-193` (CORS `*`) |

## P1

| ID | Eff | Status | Finding | Evidence |
|---|---|---|---|---|
| **SEC-6** | S | ✅ | PII in logs and error leakage: webhook logs the first 400 chars of every body (names, emails, transcripts). 500 responses return raw `error.message`; `createBooking` returns the raw Google error text to the end user. | `webhook/route.ts:200`, `route.ts:224-228`, `calendar.ts:135-137` |
| **SEC-7** | M | ✅ | **Prompt-injection posture.** Retrieved text is pasted into the *system* prompt unmarked; the index contains third-party code from forks/others (`prime-environments` 10 chunks, `Unofficial` 15, `mattermost` 1, `grass` 5, `guppy` 17) so repo content can steer the model. Client can forge `assistant` turns (any non-`user` role is mapped to assistant). No instruction to refuse prompt disclosure. Markdown renderer allows `<img>` → an injected image URL can exfiltrate chat text. XSS itself is OK (react-markdown v10 escapes raw HTML and sanitises `javascript:` URLs). | `route.ts:68-71, 75-79`, `app/page.tsx:257-266` |
| **SEC-8** | S | ✅ | **Dependencies.** `npm audit --omit=dev`: 10 vulns (1 critical, 6 high). `next@16.2.3` has 7 advisories (fix in 16.4.x), plus `qs`, `zod`, `source-map-js`, `postcss`, `sharp` (the latter via next; next/image is unused). Unused deps `@anthropic-ai/sdk`, `@google/generative-ai`, `pdf-parse`, `@types/pdf-parse` increase surface and install time. | `package.json`; `grep` finds no imports |
| **BK-1** | M | ✅ | **Time-zone dependence.** Day grouping/labels use server-local `toDateString()` / `toLocaleDateString` with no `timeZone` (`booking.ts:58-62, 69-83, 164-165, 237-243`). Correct on Vercel (UTC) and in IST only by luck: reproduced with `TZ=America/Los_Angeles`, where one IST day's slots split into "Sunday" + "Monday". | probe output in PROGRESS |
| **BK-2** | S | ✅ | **Calendar failure looks like "no slots".** Any Google error (bad token, quota) is swallowed and `[]` returned, so the bot says "I don't have any open slots" – exactly EVALS failure #1. | `lib/calendar.ts:87-90`, `booking.ts:295-301` |
| **BK-3** | S | ✅ | **Voice email normalisation gaps.** `minus` is *deleted* instead of becoming `-`; no `underscore`/`dash`/`hyphen`/`plus`/`double x`/`oh`; any number word is rewritten even inside names. Naive ISO `slotTime` (no offset) is parsed as server-local (UTC) = 5.5 h off. | `webhook/route.ts:124-148, 163` |
| **BK-4** | S | ✅ | `selectVoiceSlots` derives the IST hour via `toLocaleTimeString(hour12:false)`, which yields `"24"` at midnight on some engines; works today only because slots are 08:00–18:30. Voice shows 09:00–17:00 only vs chat 08:00–18:30 (parity gap, undocumented). | `webhook/route.ts:26-29` |
| **RT-1** | S | ✅ | **Router: booking false positives.** Substring `book`, `schedule`, `slot`, `meeting`, `interview`, `available` → booking flow (and a calendar call) for "Tell me about the Book-Author Relation project", "Facebook", "Jupyter Notebook", "scheduler", "interview experience". Measured: **5 of 15** on-topic probes misfire. | `lib/router.ts:100-117` |
| **RT-2** | S | ✅ | **Router: off-topic guard bypassed.** On-topic keywords are substrings: `you` (matches almost everything), `api` (in "capital"), `rest` ("restaurant"), `work`, `name`, `git` … Measured: **7 of 11** clear off-topic probes pass as `chat` (only caught later by the LLM, costing a retrieval + Groq call). | `lib/router.ts:120-143, 172-181` |
| **RT-3** | S | ✅ | **Router: false cancel/restart inside the booking flow.** Phrases `skip`, `i'm good` cancel the booking ("I'm good with Tuesday"); in `awaiting_email` any email containing `book`, `slot`, `meeting`… (e.g. `bookworm@gmail.com`) restarts the flow instead of booking. | `router.ts:57-60, 100-117, 215-221` |
| **RAG-1** | S | ✅ | **Pinecone path has no score threshold** (the 0.25 cosine cut-off exists only for the in-memory fallback), so off-topic queries still receive 5 chunks of context in production. | `lib/retriever.ts:27, 70-88, 99-103` |
| **RAG-2** | M | ✅ | **Pinecone index can't be populated from the repo.** `upsertChunks` has no caller and `scripts/` is gitignored, so a fresh clone cannot seed or rebuild anything (`npm run rebuild-index` points at a missing file). | `lib/vector-db.ts:62`, `package.json:10`, `.gitignore` (`/scripts/`) |
| **HYG-1** | S | ✅ | **Lint fails** (5 errors) so no CI gate is possible. | see PROGRESS Phase 0 |
| **HYG-2** | S | ◐ | README describes Railway (prod is Vercel), references `scripts/google-auth.mjs` / `build-index.mjs` that don't exist, documents `VAPI_PUBLIC_KEY` (the key is hard-coded in `page.tsx:7`; env var unused), omits `PINECONE_API_KEY`, and says state is "stateless client-side" as a design goal. No `.env.example`. | `README.md` |

## P2

| ID | Eff | Status | Finding | Evidence |
|---|---|---|---|---|
| **RAG-3** | M | ☐ | Persona facts (CGPA 8.18, PR #7097/#7005, 40 %/25 %, project list, BITS/2027) are hard-coded in `persona.ts` *and* `resume.txt` *and* the index → drift risk. Also `Expected 2027 / 3rd Year` are time-sensitive. | `lib/persona.ts:39-40` |
| **RAG-4** | M | ✅ | Retrieval query is only the last user message; follow-ups ("tell me more", "and the second one?") retrieve garbage. | `route.ts:62` |
| **RAG-5** | S | ✅ | No `temperature` set (Groq default 1.0) for a grounded-answer bot; `max_tokens` is deprecated for `max_completion_tokens`; no timeout/retry on Groq/Cohere. | `route.ts:82-86`, groq-sdk types |
| **RAG-6** | M | ◐ | Index quality: the PROJECTS section is one 3 KB chunk (built before `splitProjectsSection`); 59 chunks come from forks/third-party repos; repo's own source (`ai-persona-chat`, 14 chunks) can be quoted back. Needs a Cohere key to rebuild → *Needs real testing*. | `data/index.json` analysis |
| **RAG-7** | S | ☐ | `/api/init` is public and can trigger a full GitHub+Cohere rebuild if the static import ever fails. | `app/api/init/route.ts` |
| **BK-5** | S | ✅ | `"2:30"` (no am/pm) is not understood although `"at 14:00"` is; month-name matching is substring based (`mar`⊂`market`, `may`, `dec`⊂`decide`); date parsing uses the current year only (late-December request for January fails). Name extraction falls back to `"Guest"`. | `booking.ts:100-139, 273-281` |
| **BK-6** | S | ✅ | Webhook parses only `toolCallList[].function.{name,arguments}`; Vapi payloads may carry `toolCalls[]` / top-level `name`+`parameters`. Unknown shapes silently return `ok`. | `webhook/route.ts:206-213` |
| **FE-1** | M | ✅ | Accessibility: no `aria-live` on the transcript, input has no label, icon-less buttons lack focus-visible styles, voice overlay not a dialog, no `<main>`; colour contrast of `text-gray-500` on `gray-950` is borderline. | `app/page.tsx` |
| **FE-2** | S | ✅ | Mobile: voice overlay hard-codes `top: 65px`; chat height `calc(100vh - 65px)` (breaks under mobile browser chrome → use `dvh`); header does not wrap on narrow screens. | `page.tsx:179, 244` |
| **FE-3** | S | ✅ | Error/loading states: no retry; non-JSON error body shows "Connection error"; mic-permission failure on `vapi.start` is silent; Vapi call is not stopped on unmount; no abort of in-flight fetch. | `page.tsx:92-99, 128-130` |
| **FE-4** | S | ✅ | Fonts: `Geist_Mono` is loaded but unused and `globals.css` overrides body font with Arial, so Geist Sans is also dead weight. | `app/layout.tsx`, `globals.css:25` |
| **FE-5** | S | ✅ | `NEXT_PUBLIC` config: Vapi public key + assistant id hard-coded. (Public by design, but should be env-overridable.) | `page.tsx:7-8` |
| **PERF-1** | S | ✅ | New OAuth2 client (and token refresh round-trip) for every calendar call; no memoisation of query embeddings or retrieval results; full slot list (~170 slots ×2) echoed in every request/response. | `calendar.ts:8-18`, `retriever.ts:43-50`, `route.ts:162` |
| **PERF-2** | S | ☐ | No tests, no CI, no automated evals; `verify-booking.ts` at repo root is type-checked by the build but needs live Google credentials. | repo root |
| **HYG-3** | S | ➜ | Personal / third-party files tracked in git (**owner decision**): `lib/Vinay_Resume (1).pdf` (343 KB, contains phone + email), `lib/Assignment (2).pdf`, `Assignment (2).json`, `Assignment (2).content.txt` (employer's screening assignment text), `.claude/settings.local.json`. None are imported by code. | `git ls-files` |
| **HYG-4** | S | ➜ | Personal data hard-coded: phone `+91-8822091421` and Scaler email in `lib/config.ts:36-38` (and in `data/resume.txt`/index, so the LLM will print them to anyone); a *different* personal Gmail (`chopravinaykumarchopra@gmail.com`) hard-coded as the calendar attendee in `lib/calendar.ts:117`. | owner decision on exposure; moved to config in Phase 4 |
| **HYG-5** | S | ☐ | `data/index.json` is 2.85 MB, committed (inlined into several server chunks). Embedding floats are stored at full precision. | `data/index.json` |

## P3

| ID | Eff | Finding |
|---|---|---|
| **UX-1** | M | Quick-reply chips for days/times in the booking UI instead of typing numbers. |
| **UX-2** | S | Copy-to-clipboard, "new chat" button, persisted conversation. |
| **OPS-1** | M | Durable rate limiting + booking session store (Upstash/Vercel KV) – in-memory limits are per serverless instance. |
| **OPS-2** | M | Phone number via Twilio (already on the owner's own "improve next" list), LLM-as-judge nightly evals with real keys. |
| **RAG-8** | L | Hybrid (BM25 + dense) retrieval; index-time dedupe of near-identical code chunks. |

## Not found (checked)

- **Secrets in git history:** scanned all 17 commits (all refs) for Groq/Google/GitHub/Pinecone/Cohere/OpenAI token patterns, `.env*` files and credential files: none found. `scripts/` was never committed, so the original (credential-bearing) auth script never reached git. A second, broader scan is repeated in Phase 5.
- **XSS via react-markdown:** none (no `rehype-raw`; URLs sanitised). Image-based exfiltration is covered by SEC-7.
- **Secrets in the client bundle:** only the Vapi *public* key and assistant id (intended to be public).

---

# Phase 3 – measured optimisations

Method: deterministic and offline. Call counts come from mock-counting tests (`tests/retriever.test.ts`, `tests/booking-guard.test.ts`, `tests/router.test.ts`); sizes from `npx tsx evals/measure.ts` and `next build` of the original commit `45bbddc` (fresh `npm ci`) vs HEAD. Tokens ≈ chars/4. **No live latency was measured** (no keys); latency effects below are inferred from call counts and labelled as such.

| Metric | Before | After | How |
|---|---|---|---|
| Cohere calls for a *repeated* question | 2 (embed + rerank) | **0** | embedding + result cache (30 min, 200 entries) |
| Pinecone queries for a repeated question | 1 | **0** | same cache |
| Cohere/Groq calls for clearly off-topic messages | 3 (embed, rerank, Groq) for 7 of 11 off-topic probes | **0** for 11 of 11 | router fix (RT-2) – blocked before any API call |
| Calendar API calls caused by non-booking messages ("Book-Author project", "Facebook"…) | OAuth refresh + freebusy for 5 of 15 on-topic probes | **0** | router fix (RT-1) |
| OAuth client constructions per calendar call | 1 per call (each triggers a token refresh round-trip) | **1 per instance** | memoised client |
| Google calls to *confirm* a booking | 1 insert (+ token refresh) | 2 (freebusy re-check + insert) | **+1 deliberately**: the double-booking guard (SEC-3) |
| Pinecone path, off-topic query | rerank call + 5 junk chunks (~1.8k tokens) sent to Groq | **no rerank, no context** | threshold on Pinecone tier (RAG-1) |
| History tokens sent to Groq, 40-turn chat | ≈ 5,930 and unbounded | **≈ 1,130** (16-message cap) | `parseMessages` |
| System prompt | ≈ 878 tokens (3,510 chars) | ≈ 1,118 tokens (4,472 chars) | **+~240 tokens** per request for the SECURITY section (SEC-7) – a deliberate cost |
| Typical context per request | ≈ 1,850 tokens (5 × 1,481 chars) | unchanged | worst case 7.2k tokens when the five largest chunks win |
| Client JS (all chunks) | 1,044,225 B | **986,993 B** (−5.5 %) | Next 16.4.5 + removed libs |
| Static font assets | 11 woff2 = 146 KB | **0** | unused Geist fonts removed (page looks identical – CSS already forced Arial) |
| Server JS emitted (sum of all chunks) | 37.1 MB | 33.3 MB | index-build code (GitHub/Cohere/pdf) out of the bundle, dead deps removed, Next bump |
| Groq call robustness | no timeout/retry | 25 s timeout, 1 retry, temperature 0.3 | RAG-5 (quality effect unverified live) |
| Follow-up retrieval ("tell me more") | searches the 3 words alone | searches with the previous question | RAG-4 |

Inferred latency: a cache hit removes two sequential Cohere round-trips from time-to-first-token (typically on the order of 100–400 ms each in my experience – **unmeasured here**). Streaming (Phase 4a) addresses perceived latency for the cache-miss case.

### Measured and rejected
- **Quantising `data/index.json` embeddings to 5 decimals:** −29 % file size (2.85 → 2.03 MB), max cosine drift 1.2e-5. But JSON parse is only **17 ms** and a full 198-chunk cosine scan **0.18 ms**, so cold-start gain is a few ms and it would add another ~2 MB blob to git history. Not worth it.
- **Dropping `end` from slot payloads** (30 KB per booking response/request for 219 slots): ~40 % smaller but changes the API shape for ~12 KB; skipped, noted for later.
