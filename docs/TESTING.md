# Testing (Milestone 1)

## Automated tests

```bash
pnpm --filter @three-d/web test        # Vitest: 313 tests in 25 files
pnpm --filter @three-d/web lint
pnpm --filter @three-d/web typecheck
pnpm --filter @three-d/web build
sh scripts/verify-stack.sh             # running Docker stack: health, DB roles, webhooks protected, secrets ignored
```

Database tests run against a throwaway database that is created, migrated and dropped per run
(`tests/setup/global-db.ts`). They need the Compose Postgres (`localhost:5434`) and never touch the app data.

| Area | Files | What they prove |
|---|---|---|
| Schema & migrations | `tests/db/migrations.test.ts`, `state-machine-sync.test.ts`, `foreign-keys.test.ts`, `crud.test.ts` | All 14 migrations apply cleanly and idempotently; the TS and SQL state machines agree; cross-project references are impossible |
| State machine | `tests/db/state-transitions.test.ts`, `tests/workflow/lifecycle.test.ts` | Every illegal transition is refused by the database itself |
| Concepts & images | `tests/db/concept-generation-functions.test.ts`, `concept-image-functions.test.ts` | Partial failure (3 of 5 fails), per-concept retry, duplicate claims, stale results ignored, storage validation, lazy recovery |
| Refinement chain | `tests/db/revision-chain.test.ts` | Revisions chain correctly; nothing overwritten; stale-version / wrong-project / busy requests refused; 4 concurrent requests → 1 revision; failed revision retried in place (claim cleared); "use this version" branches |
| Final design & views | `tests/db/final-views.test.ts` | Canonical design immutable; 3 concurrent finalize requests → 1 design; only failed views retried; regenerate one view from the master; superseded results ignored; approve all |
| Drive delivery | `tests/db/drive-delivery.test.ts`, `tests/n8n/drive.test.ts` | Clean upload; repeat = no-op; crash after create found by tag; trashed file recreated; partial failure → retry uploads only LEFT; outage, auth failure, run lock, stale-run takeover |
| n8n logic | `tests/n8n/*.test.ts` | Claude request/repair/validation, image provider requests/normalisation/retry policy, view prompts, Drive loop; every workflow JSON follows the conventions and every Code node compiles |
| HTTP / security | `tests/http/access-gate.test.ts`, `api-errors.test.ts`, `tests/n8n/client.test.ts` | Session tokens (expiry, tampering), safe redirects, gate decisions (pages/API/Server Actions/exemptions/fail-closed), DB outage → 503 without leaking details, n8n client contracts |

## Mock providers

Every AI setting travels with each job, so mock runs need no API keys:

| Variable | Values |
|---|---|
| `AI_PROVIDER_MODE` | `live` / `mock` |
| `AI_MOCK_SCENARIO` (Claude) | `ok`, `repairable`, `malformed_then_ok`, `too_similar_then_ok`, `truncated_then_ok`, `api_error_then_ok`, `always_malformed`, `api_down`, `transport_error` (timeout), `auth_error`, `refusal`; refinement: `refine_malformed_then_ok`, `refine_vague_preserve_then_ok`, `refine_down_once`, `refine_down`, `refine_refusal`; views: `views_malformed_then_ok`, `views_down` |
| `AI_IMAGE_MOCK_SCENARIO` | `ok`, `slow`, `timeout`, `fail:<n>` (item *n* fails on its first version; a retry succeeds), `fail_always:<n>`, `blocked`, `api_error_then_ok`, `no_image_then_ok`, `api_down`, `auth_error`, `model_not_found` |
| `DRIVE_MODE` | `live` / `test` (Drive test double, `docs/GOOGLE-DRIVE.md`) |

## Production-readiness audit (2026-10-06)

### Full user journey: live

Real Claude (`claude-sonnet-5-5`), real images (Pollinations: FLUX.2 klein for concepts/edits,
gpt-image-1-mini for views), Drive **test double**. Run entirely through the UI on project
*Mechanical Wolf Bust (M1 audit)*:

| # | Step | Result |
|---|---|---|
| 1–2 | Create project, enter brief | ✓ redirected to the workspace |
| 3–6 | Generate 3 concepts → images → gallery | ✓ 3 concepts, 3 images |
| 7–8 | Reject concept 3, approve concept 1 | ✓ dimmed + Restore; Approved badge |
| 9–11 | Refine ("smaller horns, more mechanical, more aggressive") | ✓ Claude: 60% horns + mechanical detail; edited image |
| 12–13 | Second refinement on revision 1 | ✓ revision 2 based on revision 1; history intact |
| 14 | Finalize revision 2 (confirmation shows image, concept, "Revision 2", description) | ✓ canonical design |
| 15 | Four views | ✓ Claude view instructions + 4 images → VIEW_REVIEW |
| 16 | Regenerate BACK | ✓ BACK v2, v1 kept; others untouched |
| 17–21 | Approve all → Drive folder → uploads → project.json → COMPLETED | ✓ 16 items, events `DRIVE_UPLOAD_COMPLETED`, `PROJECT_COMPLETED` |

### Full user journey: clean environment

A second Compose project from `.env.example` only (fresh volumes, other ports), access gate **on**, mock
AI, Drive test double: `docker compose up -d --build` → n8n owner + API key → `pnpm n8n:credentials` +
`pnpm n8n:deploy` → sign in → create (4 concepts) → reject/approve → refine → finalize revision 1 → views →
regenerate FRONT → approve all → "Design package completed." ✓. Then `docker compose down` (volumes
kept) + `up`: projects, assets, Drive records, events, 7 active workflows, 7 credentials and the n8n owner
login all survived; webhooks worked. ✓

### Failure cases (through n8n)

| Case | How | Result |
|---|---|---|
| Claude timeout | `transport_error` ×3 | ✓ project FAILED "AI service temporarily unavailable", 3 attempts, retryable |
| Claude invalid response | `malformed_then_ok` / `always_malformed` | ✓ repaired on attempt 2 / FAILED with clear reason |
| Image model timeout | `timeout` (all images) | ✓ concepts kept, images FAILED with reason, project in review |
| Image model failure, one of several | `fail:2` | ✓ 1 and 3 READY, 2 FAILED; retry → READY; others untouched |
| View instructions (Claude) down | `views_down` | ✓ all views FAILED with reason; retry generated them |
| One view fails | `fail:3` | ✓ LEFT failed, others kept; a READY view can't be redone meanwhile (409); retry → only LEFT v2 |
| Google Drive failure | test double: 401 on lookup; 503 on every create; 503 on LEFT uploads | ✓ auth → "reconnect Google Drive"; outage → retryable; partial → retry uploads only LEFT, no duplicates |
| Database failure | `docker compose stop postgres` | ✓ health 503 (no internal details), API 503 `database_unavailable`, page "Couldn't load this page", n8n 503; full recovery after start |
| Duplicate webhook | concepts ×2, refine (same revision), views, Drive ×2 | ✓ one 202, the other 409; no double AI/Drive cost |
| Duplicate finalize | 3 concurrent `finalize_design` + UI double click | ✓ one final design |
| Browser refresh / closed / returning later | during concept images, refinement, views, Drive | ✓ state from the database; generation continues server-side |
| Invalid project/concept ID | API, pages, Server Actions | ✓ 404 / "not found"; concept from another project refused |
| Unauthorized | 7 webhooks without/with wrong token; internal API without bearer; app without session (gate on) | ✓ 403 / 401 / redirect to sign-in |
| Malformed request | bad JSON, missing fields, too long, bad UUIDs, bad view types, SQL-ish IDs | ✓ 422 with field messages; 413 for oversized bodies |
| Concurrent requests | 4 refine requests at once; 3 finalize; parallel webhooks | ✓ exactly one wins |

### Security audit

| Check | Result |
|---|---|
| API keys / Google credentials / n8n encryption key in the frontend | ✓ none: client bundle and all HTML/RSC/API responses scanned for every secret value in `.env`; no `NEXT_PUBLIC_` variables |
| Webhooks protected | ✓ all 7 (Header Auth); fan-out uses the same credential |
| Authentication | **Fixed:** there was none. Added the studio access gate (password + signed HttpOnly cookie, `proxy.ts`). Per-user accounts are a known limitation |
| Authorization | **Fixed:** select/reject/restore/retry-image actions didn't check that the concept belongs to the project. Refine/finalize were already checked in the database |
| Input validation | ✓ Zod at the app boundary; UUID/enum/length validation in every n8n workflow; DB constraints and triggers |
| SQL safety | ✓ parameterised queries only (Drizzle, `$n` placeholders in n8n); state changes through functions |
| File validation | ✓ magic bytes (PNG/JPEG/WebP), 20 MB cap, content-addressed atomic writes, no user-supplied paths |
| Upload / body limits | **Fixed:** internal asset API had no length cap and the public JSON API read unlimited bodies → 413 limits added |
| CORS | ✓ same-origin only (no `Access-Control-Allow-Origin`) |
| Security headers | **Fixed:** none were set → CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP |
| Error messages | **Fixed:** `/api/health` exposed a driver error ("getaddrinfo … postgres"); unexpected API errors returned bare 500s → sanitised, logged server-side |
| Expensive work duplicated | **Fixed:** a duplicate refine webhook could pay Claude + images twice → revision claim |
| Run-lock consistency | **Fixed:** Drive workflow timeout (30 min) exceeded the stale-run window (20 min) → 19 min |
| Traceability | **Added:** `n8nExecutionId` on every settled event |

### UI audit

Checked at 375 px (mobile), 768 px (tablet), 1024–1440 px (desktop) and a short 1024×600 screen: no
horizontal scrolling on any page. Loading, empty, generation, error, approval and completion states were
reviewed. Fixed:
- Dialogs taller than the screen hid their buttons (Finalize unreachable on short screens).
- Long unbroken project names were clipped.
- The phone header got crowded (compact "+" button).
- The master-design card took the full width on phones.
- The navigation showed on the sign-in page.

## Known issues

- **Multi-view quality depends on the image model.** With the Pollinations models available on the test
  key, views keep the object but rotate only partly (BACK and RIGHT aren't true opposite sides). The
  instructions are correct; Nano Banana (Gemini) or a paid Pollinations model is expected to do better but
  **hasn't been tested** (no Gemini key / paid balance).
- **Unknown project pages answer HTTP 200** with the not-found UI and `noindex` (Next.js streaming:
  the status is committed before the lookup). API routes answer 404.
- **Embedded browser pane only:** a page loaded while the pane's tab is hidden defers hydration until it's
  shown. Regular browser tabs aren't affected.

## Known limitations (Milestone 1)

- **One shared studio password**: no per-user accounts, roles or project ownership (Better Auth in the
  architecture, decision D1). Anyone with the password sees every project.
- **No rate limits or cost caps** beyond 2–5 concepts per request and bounded retries; refinements and
  view regenerations are unlimited.
- **Images are served at full resolution** (no resized variants); fine for ~1 MP renders, heavier on slow
  connections.
- **Google Drive live path not exercised** against a real Google account (needs an OAuth client +
  "Connect my account" in n8n). Drive delivery is verified against the test double.
- **Nano Banana (Gemini) not exercised** (no API key); the Pollinations provider was used for live tests.
- **n8n execution data includes image payloads**, so the n8n database grows with use (pruned after 14 days
  by default).
- **Lazy recovery** runs when a project is opened or polled; a job stuck in a project nobody opens stays
  stuck until then.
- **Single web instance**: login brute-force limiting and the asset volume are per container.
- Out of scope (Milestone 2): H3D, Fusion 360, 3D model generation, Cults3D, SEO publishing, automated
  rendering.
