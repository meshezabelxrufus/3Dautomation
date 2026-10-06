# n8n workflows (Milestone 1)

n8n is the orchestration layer: every AI call (Claude, the image model) and every Google Drive call happens
in n8n, never in the browser or the web app. The **database stays authoritative**: workflows hold no state
of their own; they read and change it only through PostgreSQL functions (state machine enforced by
triggers). That's why a crash, restart or duplicate request can't corrupt a project. The next read or
retry sees exactly what was committed.

Source of truth: `n8n/workflows/*.json` (deployed with `pnpm n8n:deploy`). Shared logic lives in
`n8n/lib/*.cjs`, is inlined into Code nodes at deploy time (`/* @include lib/… */`), and is unit-tested by
the app (`apps/web/tests/n8n/`).

## Conventions

| Rule | Why |
|---|---|
| Names start with `[3D Studio]`, webhook paths with `3d-studio/`, tag `3d-automation` | Separation from any other workflows on a shared instance; the deploy script refuses anything else |
| Every webhook uses Header Auth (`X-Webhook-Token`) | Only the web app (and the workflows themselves) may start jobs |
| Credentials are referenced by **name** in the JSON | IDs are resolved per instance; no secrets or IDs in git |
| Long jobs answer `202` immediately, then work | The web app never waits on AI; it polls `/status` |
| Every job is **claimed** in the database before any paid call | A duplicate request gets `409` instead of paying for Claude/images twice |
| Retries are bounded (3 attempts for AI calls, 4 per Drive item, step cap 600) with backoff | No runaway loops or cost |
| Every failure path ends in a `fail_*` function and a *Stop and Error* node | The project shows a client-safe reason; the n8n execution is marked failed with the technical detail |
| Settled events carry `n8nExecutionId` | Any project event can be traced to its execution in n8n |
| Executions are saved (success and error), pruned after `EXECUTIONS_DATA_MAX_AGE` hours (default 336) | Traceability without unbounded growth |
| Deploy-time URLs `__3DS_APP_BASE_URL__`, `__3DS_N8N_SELF_URL__`, `__3DS_FAKE_DRIVE_URL__` | Callers can't redirect n8n (or its callback token) to another host |

## Workflows

| File | Workflow | Webhook | Timeout |
|---|---|---|---|
| `m1-project-create.json` | Project — create | `3d-studio/project-create` | 30 s |
| `m1-concepts-generate.json` | Concepts — generate | `3d-studio/concepts-generate` | 25 min |
| `m1-concept-image-generate.json` | Concept image — generate | `3d-studio/concept-image-generate` | 10 min |
| `m1-concept-refine.json` | Concept — refine | `3d-studio/concept-refine` | 10 min |
| `m1-views-generate.json` | Views — generate | `3d-studio/views-generate` | 30 min |
| `m1-view-image-generate.json` | View image — generate | `3d-studio/view-image-generate` | 10 min |
| `m1-drive-export.json` | Drive — export | `3d-studio/drive-export` | 19 min |

The app's lazy recovery deadlines sit just above these timeouts (concepts 26 min, image jobs and
refinements 11 min, views run 31 min, Drive 20–21 min). A job whose n8n execution died is failed
(retryable) the next time the project is opened.

### Project — create
Validate → `INSERT` project + `PROJECT_CREATED` event in one statement → `201`. Database unavailable → `503`.

### Concepts — generate
```
start_concept_generation  (DRAFT/CONCEPT_REVIEW/FAILED → GENERATING_CONCEPTS; refuses a second run) → 202
→ Claude (structured JSON schema, effort "high", refusal fallback; repair loop: parse → local repair →
  validate → send errors back to Claude; up to 3 attempts; 429/5xx backoff; auth/refusal fail at once)
→ save_concept_texts       (concepts appear as GENERATING)
→ fan out: one "Concept image — generate" execution per concept (parallel, separate executions)
→ poll the database until no concept of this batch is GENERATING (3 s, max ~12 min)
→ finish_concept_generation (leftovers FAILED, event, → CONCEPT_REVIEW)
failure before concepts exist → fail_concept_generation (→ FAILED, retryable)
```

### Concept image — generate
```
start_concept_image (claim; FAILED → GENERATING on retry; 409 if already running/done) → 202
→ image model (Gemini generateContent / Pollinations / mock), up to 3 attempts (408/425/429/5xx and
  "no image" retried; auth, model-not-found and safety blocks fail at once)
→ POST app /api/internal/assets (bytes validated and stored by the app; never a provider URL)
→ complete_concept_image (READY, image URL, event)        or fail_concept_image (FAILED + reason)
```

### Concept — refine
```
load + claim the revision (project, concept and revision must belong together; claimed_at prevents a
duplicate run) → 202
→ fetch the current version's image (internal API)
→ Claude sees the image + design record + revision chain → summary · changes · preserve ·
  edit_prompt · revised_prompt (strict JSON; vague "everything else" preserve lists are rejected)
→ image model edits the current image with edit_prompt → store (REVISION asset)
→ complete_refinement (revision READY, becomes the current version)   or fail_refinement (retryable)
```

### Views — generate
```
start_view_generation (first run: all four; retry: failed ones; regenerate: exactly the requested view;
  successful views are never redone while generating) → 202
→ view instructions stored?  no → fetch master image → Claude writes design_summary, invariants and
  front/back/left/right prompts → save_view_prompts (write-once, canonical)
→ fan out one "View image — generate" per view → poll until settled → finish_view_generation
  (all four READY → VIEW_REVIEW)
Claude fails → fail_view_preparation (this run's views FAILED, retryable)
```

### View image — generate
```
start_view_image (claim; returns the canonical instruction and the master asset) → 202
→ image model edits the MASTER image (never an earlier view) → store (VIEW asset)
→ complete_view_image   or fail_view_image
```

### Drive — export
```
start_drive_export (run lock: 409 if running, 200 if already completed) → 202
→ loop over items (root, project folder, 01–04, concept and revision images, MASTER, FRONT, BACK,
  LEFT, RIGHT, project.json): verify stored Drive ID → else find by appProperties tag → else create;
  then upload content (PATCH media). save_drive_item after every Drive call.
→ complete_drive_export (→ COMPLETED, DRIVE_UPLOAD_COMPLETED, PROJECT_COMPLETED)
  or fail_drive_export (successful items kept; retry uploads only what's missing)
```
See `docs/GOOGLE-DRIVE.md`.

## Credentials

| Name | Type | Notes |
|---|---|---|
| `3D Studio — App DB` | Postgres | The app database (functions only) |
| `3D Studio — Inbound webhook token` | Header Auth | `X-Webhook-Token` (also used for fan-out to child workflows) |
| `3D Studio — App callback token` | Header Auth | `Authorization: Bearer …` for `/api/internal/*` |
| `3D Studio — Anthropic` | Anthropic | Claude |
| `3D Studio — Gemini` | Google Gemini (PaLM) API | Nano Banana (`IMAGE_PROVIDER=gemini`) |
| `3D Studio — Pollinations` | Header Auth | Image models via Pollinations (`IMAGE_PROVIDER=pollinations`) |
| `3D Studio — Google Drive` | Google Drive OAuth2 | Needs **Connect my account** in the n8n UI |

`pnpm n8n:credentials` creates or updates them from `.env`. API keys are synced only when set, and never
overwritten with a placeholder.

## Operating

| Task | How |
|---|---|
| Deploy / update | `pnpm n8n:credentials && pnpm n8n:deploy` (backs up every workflow on the instance first, to `n8n/backups/`) |
| See what's deployed | `pnpm n8n:status` |
| Trace a project | Its events (`project_events.payload.n8nExecutionId`) → n8n UI → Executions |
| A job looks stuck | Open the project: lazy recovery fails it after its deadline and the UI offers a retry |
| Change models | `CLAUDE_MODEL`, `IMAGE_PROVIDER`, `IMAGE_MODEL`, `POLLINATIONS_MODEL`, `POLLINATIONS_VIEW_MODEL` in `.env`, then recreate `web` (sent with each job; no redeploy) |
| Test without paid APIs | `AI_PROVIDER_MODE=mock` (+ scenarios, `docs/TESTING.md`), `DRIVE_MODE=test` |
