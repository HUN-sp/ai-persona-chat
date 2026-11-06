# Progress log

Branch: `claude/eager-mccarthy-26ie93`. No real API keys were available; every external service is mocked in tests. Nothing here was verified against live Groq, Cohere, Pinecone, Google Calendar or Vapi.

## Phase 0 – Baseline (read-only)

| Check | Result |
|---|---|
| `npm install` | OK (~48 s). Reports 24 vulnerabilities (10 in prod deps: 1 critical, 6 high, 3 moderate). Install rewrites `package-lock.json` slightly (12 lines removed); I reverted that during the read-only phase. |
| `npm run lint` | **FAIL – 5 errors, 1 warning**: `no-explicit-any` (`app/api/chat/route.ts:127`, `verify-booking.ts:57`), `react/no-unescaped-entities` ×2 (`app/page.tsx:238`), `prefer-const` (`lib/booking.ts:104`), unused import `isOffTopic` (`lib/booking.ts:14`). |
| `npx next build` | **PASS** (~35 s, Next 16.2.3 Turbopack). Routes: `/` static; `/api/chat`, `/api/init`, `/api/vapi/webhook` dynamic. TypeScript step passes. |
| Tests | **None exist.** `verify-booking.ts` is a manual script that needs live Google credentials. |
| Build artefacts | client JS chunks 1.1 MB total; `data/index.json` (2.85 MB) is inlined into server chunks (≈3.7 MB each, several copies). |

## Decisions

1. Used the already-assigned branch `claude/eager-mccarthy-26ie93` as the "new branch".
2. Did the audit myself rather than spawning subagents: I had already read every file and subagents would have started cold. I may use a reviewer subagent on the final diff.
3. Webhook secret enforcement is **fail-open when `VAPI_WEBHOOK_SECRET` is unset** (log a warning), because enforcing by default would silently break the live voice agent until the secret is configured in Vapi. The server-side slot validation bounds the damage in the meantime.

## Phase 2 – P0/P1 fixes (done)

One commit per fix, each with offline tests (206 tests, 13 files; every external service mocked).

| Commit | Fixes |
|---|---|
| booking guard | SEC-1/2/3: only `slot.start` is trusted; must be a future weekday 08:00–18:30 IST half-hour ≤14 days; end = start+30 m; freebusy re-checked right before insert (fails closed); per-slot mutex serialises chat/voice races |
| chat state | SEC-1: `sanitizeBookingState` rebuilds untrusted client state; slot-taken → fresh availability |
| voice slotTime | SEC-2/BK-4: no fabricated slots; offset-less ISO = IST; ≤2 min snap; IST-safe hour maths |
| spoken email | BK-3: `minus`→`-`, underscore/dash/plus, double/triple, "at the rate of" |
| calendar outage | BK-2: outage ≠ "no open slots" (chat + voice) |
| HTTP hardening | SEC-4/5/6/BK-6: `VAPI_WEBHOOK_SECRET` (X-Vapi-Secret or Bearer; /api/chat alias shares it), body/message caps, roles/types validated, history ≤16, per-IP rate limits, global 12 bookings/h, CORS only for `ALLOWED_ORIGINS`, no body logging, generic 500s |
| router | RT-1/2/3: probe set 21/37 → 37/37; 79-case fixture |
| prompt safety | SEC-7: fenced untrusted context, SECURITY rules, leak/fake-booking output guard, no `<img>`/raw HTML in UI |
| retriever | RAG-1: threshold on Pinecone tier; "empty index" vs "nothing relevant" |
| scripts/hygiene | RAG-2/HYG-2: `scripts/` tracked (rebuild-index, seed-pinecone, google-auth), `.env.example`, fork filter, GitHub fetch without token |
| deps | SEC-8: unused deps removed, Next 16.2.3→16.4.5, `npm audit --omit=dev` 10 → 0 |
| tz + parsing | BK-1/5: IST-explicit day maths, whole-word months, New-Year, `2:30`/`at 3`/`noon` |

### Decisions (Phase 2)
4. `.claude/settings.local.json` was untracked (`git rm --cached`) and gitignored; file still on disk. It held only a Bash allow-list, no secrets.
5. `verify-booking.ts` (needed live Google credentials, type-checked by the build) deleted; its 3 scenarios live in `tests/booking-flow.test.ts`.
6. Voice stays 09:00–17:00 IST while chat offers 08:00–18:30 (kept existing behaviour; documented).
7. Rate limits are in-memory per instance (best effort). A hard global cap needs a shared store (OPS-1, open).
8. Server-side *booking session* (Phase 4 option c) is satisfied by validation + re-check instead of a session store: with every slot validated and freebusy re-checked, tampering can only select genuinely free slots, which any user may do anyway. A real session store would need Redis/KV.
9. Forks other than `grass`/`guppy` are excluded from the *next* index rebuild (owner can change `INDEX_INCLUDE_FORKS`). The committed `data/index.json` is unchanged — it still contains 59 third-party chunks until you rebuild (Needs real testing: Cohere key).
10. `temperature` for Groq not changed yet (decide in Phase 3 with the persona work).

## Phase 3 – Optimise (done)
Measured wins only; numbers in `docs/AUDIT.md` ("Phase 3"). Highlights: repeated question 2 → 0 Cohere calls; 11/11 off-topic probes and 15/15 on-topic probes handled without a wasted LLM/calendar call; history 5.9k → 1.1k tokens at 40 turns; client JS −5.5 %; 146 KB of unused font files removed; OAuth client reused. Costs: +240 prompt tokens (security rules), +1 Google call per booking (double-booking guard). Rejected after measuring: quantising `index.json`.

## Phase 4 – Enhance (done)
Top 3 by impact/effort:
- **(a) SSE streaming** – server + UI (`Accept: text/event-stream`; JSON fallback). Verified in headless Chromium at 1280 px and 375 px with the API intercepted. Output guards run on the growing text with a 32-char hold-back.
- **(b) Data-driven persona** – `persona/template.ts` + `persona/<id>/{persona,ui}.json`; golden test proves the prompt is byte-identical; drift test ties every quoted fact to `data/resume.txt`; a test forbids hard-coded phone/email/GitHub user in `app/` and `lib/`.
- **(e) Eval harness + CI** – 25 questions + 4 booking flows offline (63 checks), live runner for real keys, GitHub Actions workflow (run #1 on this branch: success).
- (c) server-side booking session: not built; replaced by validation + re-check (Decision 8). (d) history trimming: cap done (16 messages, 4 000 chars each); summarisation not done.
Also: UI accessibility/mobile/error-state pass (FE-1/2/3/5).

## Phase 5 – Harden & document (done)
- Full gate on HEAD and on a **fresh clone**: `npm ci` → lint ✓ → `tsc` ✓ → 294 tests ✓ → `next build` ✓; `npm audit --omit=dev`: 0 vulnerabilities.
- Secrets/PII scan: see "Scan results". README, `.env.example`, `docs/PERSONA.md` written; `scripts/` tracked and `.gitignore` fixed.

### Scan results
- **History (all 45 commits, every ref):** no Groq/Google/GitHub/Pinecone/Cohere/OpenAI/Slack/AWS-style tokens, no private keys, no `.env*`/credential files ever committed (only `.env.example` now). `scripts/` was never committed, so the credential-bearing auth script never reached git.
- **`data/index.json` text (198 chunks):** no secrets. Contains the owner's own email and phone (from the resume, intentionally) and 8 chunks of this repo's *old* `app/api/chat/route.ts` plus README chunks (the persona indexes its own repo).
- **Personal data still in the repo (owner decision – nothing deleted):**
  - `data/resume.txt`, `persona/vinay/persona.json`, `tests/fixtures/system-prompt.golden.txt`, `data/index.json`: phone `+91-8822091421` and Scaler email. The chat prompt prints them to anyone who asks.
  - `persona/vinay/persona.json`: a second personal address (`chopravinaykumarchopra@gmail.com`) used as the calendar attendee; override with `OWNER_CALENDAR_EMAIL`.
  - `lib/Vinay_Resume (1).pdf`, `lib/Assignment (2).pdf`, `Assignment (2).json`, `Assignment (2).content.txt`: unused by code; the assignment files are Scaler's screening text. Recommend `git rm` them (they remain in history regardless).
  - If any of this must disappear from history, that needs a history rewrite (e.g. `git filter-repo`), which I did not do.

## Decisions (complete list)
1. Used the pre-assigned branch `claude/eager-mccarthy-26ie93`; no PRs created, nothing merged.
2. Did the audit and fixes myself rather than via subagents (I had read every file; cold subagents would re-derive context). No independent reviewer pass was run – recommend a human review of `lib/calendar.ts`, `lib/booking-state.ts`, `lib/vapi.ts`.
3. Webhook secret is **fail-open while `VAPI_WEBHOOK_SECRET` is unset** (warning logged) so the live voice agent doesn't break on deploy.
4. `.claude/settings.local.json` untracked + ignored (file kept; contained only an allow-list).
5. `verify-booking.ts` deleted; replaced by offline tests.
6. Voice stays 09:00–17:00 IST, chat 08:00–18:30 (existing behaviour kept).
7. Rate limits in memory per instance (best effort).
8. No server-side booking *session*: validation + freebusy re-check make tampering harmless (a user can only choose genuinely free slots).
9. Third-party forks excluded from the *next* index rebuild (`INDEX_INCLUDE_FORKS`, default `grass,guppy`); the committed `index.json` is unchanged.
10. Groq temperature 0.3, 25 s timeout, 1 retry, `max_completion_tokens` – unverified live.
11. Hours 1–7 without am/pm mean PM ("2:30" → 14:30) because slots start at 08:00.
12. The deterministic "Book-Author"/Facebook/etc. exclusions in the router are regression fixes, not an unbiased benchmark (fixture written alongside the fix).
13. System prompt grew by ~240 tokens for security rules; "NEVER say a booking was made" added; behaviour otherwise identical (golden test).
14. `maxDuration = 30` on `/api/chat` so cold start + retrieval + Groq (25 s timeout) is not cut by the platform default.
15. Removed unused fonts (no visible change: CSS already forced Arial).
16. Not done on purpose: quantising the index, shrinking slot payloads, LLM-as-judge, Twilio, quick-reply chips.

## Open risks
1. **Webhook is open until `VAPI_WEBHOOK_SECRET` is set** in both Vercel and Vapi (the Vapi header name/field is from documentation memory – confirm in the dashboard).
2. **Rate limiting is per serverless instance**, so it blunts but doesn't cap abuse; a hard global cap needs Upstash/Vercel KV (OPS-1). The global 12-bookings/hour cap has the same per-instance caveat. Per-IP buckets share one key (`unknown`) if no `x-forwarded-for` is present (not the case on Vercel).
3. **Cross-instance double-booking window**: two instances can both pass the freebusy check within one round-trip before either inserts (Google Calendar has no transactions). Same-instance races are fully serialised.
4. `data/index.json` is stale relative to the new fork rule and `splitProjectsSection` (PROJECTS is still one 3 KB chunk; 59 third-party chunks and 14 chunks of this repo's own source are indexed; 24 `blood-report-analyzer` chunks crowd lexical results). Rebuild needs real keys.
5. Prompt-injection defences are layered heuristics (fencing, rules, output guard), not a guarantee; forged assistant history is mitigated only by wording and the 16-turn cap.
6. Phone number and Scaler email are shown to anyone who asks the bot (by design of the resume).
7. Offline evals can't see real model quality; the extractive fake model and lexical retriever are proxies.
8. `eslint`/`vitest` dev-only audit notes remain (tooling, not shipped).

## Needs real testing (never claimed to work)
- [ ] **Groq**: answer quality/tone at temperature 0.3; streaming (`stream: true`), `max_completion_tokens`, timeout/retry; `npm run evals:live` (g02/g09 especially).
- [ ] **Cohere**: query embed + rerank with the new cache; the 0.25 threshold now also applied to Pinecone scores.
- [ ] **Pinecone**: `npm run seed-pinecone` (index creation args), then confirm queries return scores comparable to the in-memory path.
- [ ] **Google Calendar**: `freebusy` + `events.insert` sequence, Meet link creation, `sendUpdates`, attendee list, an actual double-booking attempt from two tabs; `npm run google-auth` flow and the scopes `calendar.events` + `calendar.freebusy`.
- [ ] **Vapi**: secret header (`X-Vapi-Secret` / Bearer), payload shape (`toolCallList` vs `toolCalls`), tools' parameter names, spoken emails ("underscore", "double zero"), out-of-order calls, slotTime echoed exactly.
- [ ] **Vercel**: SSE streaming through the platform, `maxDuration`, the environment variables, that `next build` works with no env.
- [ ] **GitHub Actions**: run #1 passed; confirm it stays green on the next push.
- [ ] **Browser**: real mic permission/denial flow for the call widget; screen reader pass.

## Secrets to rotate
No secret was found in the repository or history, so nothing *must* be rotated because of the repo. Rotate defensively if any of these were ever pasted into chat, a screenshot, an issue or a Vapi/Vercel log that others can read: Groq key, Cohere key, Pinecone key, Google OAuth client secret + refresh token, GitHub PAT, Vapi private key. Before this pass the webhook was unauthenticated and logged request bodies, so Vapi/Vercel logs from before this change may contain caller names/emails – consider clearing them. The Vapi *public* key and assistant id in `persona/vinay/ui.json` are public by design.
