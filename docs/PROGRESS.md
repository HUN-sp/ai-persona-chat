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
