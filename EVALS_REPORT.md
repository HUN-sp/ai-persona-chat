# Evals Report — Vinay Kumar Chopra AI Persona
**Scaler Screening Assignment · April 2026**

---

## 1. Voice Quality Measurement

**Stack:** Vapi AI (STT + LLM orchestration + TTS) · Groq llama-3.3-70b-versatile · Google Calendar API

| Metric | Method | Result |
|---|---|---|
| **First response latency** | Measured time from call connect to first spoken word via Vapi dashboard analytics | ~1.4s avg — within <2s hard requirement |
| **Tool call accuracy** | Manually invoked `getAvailableSlots`, `createBooking`, `searchVinayBackground` via test calls; verified webhook logs matched expected responses | 3/3 tools returning correct data; calendar slots matched real Google Calendar state |
| **Task completion** | End-to-end booking test: caller asked for availability → slot proposed → name/email collected → Google Calendar event created with Meet link | Completed without human intervention; invite received at test email |
| **Interruption handling** | Interrupted mid-sentence during slot reading; Vapi's endpointing handled gracefully without crashing | No crash; re-prompted correctly |

---

## 2. Chat Groundedness Measurement

**Stack:** Cohere `embed-english-v3.0` · Cohere `rerank-english-v3.0` · 192-chunk pre-built RAG index (GitHub repos + resume sections)

| Metric | Method | Result |
|---|---|---|
| **Retrieval quality** | Asked 10 specific questions (repo tech stacks, CGPA, open source PRs); checked whether retrieved chunks contained the answer before LLM generation | 9/10 questions had relevant chunk in top-3 reranked results |
| **Hallucination rate** | Asked 5 questions about information not in resume/GitHub (e.g. salary expectations, personal hobbies, internship details not listed); verified LLM deflected to contact email rather than inventing | 0/5 hallucinations; all deflected with "reach me at vinay.23bcs10174@sst.scaler.com" |
| **Cosine threshold effectiveness** | Set threshold at 0.25; tested off-topic questions (cricket, food, politics) — verified off-topic guard + score filter rejected these before reranking | Guard rail + threshold working correctly; no irrelevant context passed to LLM |
| **Edge case probing** | Asked about non-existent repos, future projects, team sizes not mentioned | Consistently responded "I don't have that detail" rather than fabricating |

---

## 3. Failure Modes Found and Fixed

**Failure 1 — Google Calendar credentials silently undefined on Railway**
Railway "shared variables" were defined at environment level but not propagating to `process.env` inside the running container. `googleapis` received `undefined` for all three OAuth values, threw `"No access, refresh token, API key or refresh handler callback is set"`, and the catch block silently returned `[]` — making the system claim no slots were available.
**Fix:** Added the three `GOOGLE_*` variables directly as service-level variables (not shared), bypassing Railway's shared variable propagation. Added a temporary debug log (`!!process.env.GOOGLE_REFRESH_TOKEN`) to confirm receipt before removing it.

**Failure 2 — `maxSlots=15` caused all available slots to show as one day**
The slot generator produces ~17 slots/day (8am–6:30pm IST, 30-min intervals). With `maxSlots=15`, the entire quota filled with Tuesday slots — no other days appeared. Users saw a flat list of Tuesday times with no way to reach Wednesday or beyond.
**Fix:** Raised default `maxSlots` to 200 (covers full 2-week window). Redesigned booking flow: step 1 now groups slots by day and shows a summary (`Tuesday — 15 slots, Wednesday — 20 slots...`); step 2 shows times only after a day is chosen.

**Failure 3 — Cohere SDK v7 breaking on Railway with `CO_API_KEY` mismatch**
Cohere SDK v7+ changed the expected default env var from `COHERE_API_KEY` to `CO_API_KEY`. The code explicitly passed `token: process.env.COHERE_API_KEY`, but on Railway the variable was not resolving. The SDK received `token: undefined` and threw at call time, crashing every chat response with the Cohere error surfacing to the user.
**Fix:** Changed initialisation to `token: process.env.COHERE_API_KEY ?? process.env.CO_API_KEY` in both `retriever.ts` and `indexer.ts`. Added `CO_API_KEY` as an explicit Railway service variable with the same value.

---

## 4. What I'd Improve With 2 More Weeks

- **Phone number via Twilio** — connect Vapi to a real callable number so Scaler can dial in directly rather than using the web widget
- **Streaming chat responses** — replace full-response JSON with SSE so answers stream token-by-token; eliminates the perceived latency on long answers
- **LLM-as-judge eval suite** — write 20 ground-truth Q&A pairs, run them nightly, use GPT-4o to score faithfulness and relevance; track regression across commits
- **Double-booking guard** — before confirming, re-check the slot is still free (race condition if two callers book simultaneously)
- **Voice booking memory** — Vapi loses slot context between tool calls; implement a lightweight session store so the voice agent remembers which slot was discussed without re-fetching
