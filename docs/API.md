# API reference (Milestone 1)

The web app (`apps/web`, Next.js) is the only public surface. The browser talks to it through
**Server Actions** (all mutations) and a small **read API** (polling). n8n talks to it through the
token-protected **internal API**. The browser never calls n8n, Claude, the image model or Google Drive.

```
browser ──(session cookie)──> web app ──(X-Webhook-Token)──> n8n ──> Claude / image model / Drive
                                  ^                            │
                                  └──(Authorization: Bearer)───┘  internal API (image storage)
```

All IDs are UUIDs. Errors use one shape:

```json
{ "error": { "code": "validation_failed", "message": "Invalid project", "fields": { "designBrief": "…" } } }
```

Messages are client-safe: provider errors, SQL errors and stack traces are never returned. Technical
detail stays in the n8n execution log and the server log.

## Authentication

| Surface | How it's protected |
|---|---|
| Pages, read API, Server Actions | **Studio access gate** when `STUDIO_ACCESS_PASSWORD` is set: `/login` sets an HttpOnly, SameSite=Lax session cookie (HMAC-signed with `STUDIO_SESSION_SECRET`, 30 days). Without it, pages redirect to `/login` and API calls / Server Actions get `401 unauthenticated`. A password without a valid secret fails closed (`503 misconfigured`). |
| `/api/health` | Open (monitoring). Reports nothing sensitive. |
| `/api/internal/*` | `Authorization: Bearer <N8N_CALLBACK_TOKEN>` (constant-time comparison). Not covered by the session gate. In production, block `/api/internal/*` at the reverse proxy and let n8n reach the app over the private network. |
| n8n webhooks `3d-studio/*` | Header `X-Webhook-Token: <N8N_WEBHOOK_TOKEN>` (n8n Header Auth credential). `403` otherwise. |

There is one studio password for everyone who uses the app. Per-user accounts and project ownership are not
part of Milestone 1 (see *Known limitations* in `docs/TESTING.md`).

## Read API (`GET`)

Used by the workspace for polling. `Cache-Control: no-store` on project data.

| Route | Returns |
|---|---|
| `/api/projects` | `{ projects: ProjectSummary[] }` newest first |
| `/api/projects/:projectId` | `{ project }`: name, client, brief, status, failure reason, requested concept count |
| `/api/projects/:projectId/status` | `{ status: { status, failureReason, isBusy, imagesPending, changeToken, updatedAt } }`. Polled every 2.5 s while busy, 20 s otherwise. `changeToken` changes whenever anything in the project changes; the heavier reads below refetch only then. |
| `/api/projects/:projectId/concepts` | `{ concepts }`: texts, image URL, image error, active (current) revision, status |
| `/api/projects/:projectId/revisions` | `{ revisions }`: number, base revision, feedback, Claude interpretation (changes / preserved / summary), image prompt, image URL, error, `retryable`, status |
| `/api/projects/:projectId/views` | `{ finalViews: { finalDesign, views, delivery } }`: canonical design, current FRONT/BACK/LEFT/RIGHT, Google Drive delivery (run, folder, files) |
| `/api/assets/:assetId` | The image bytes (`image/png`, `image/jpeg` or `image/webp`), `Cache-Control: public, max-age=31536000, immutable`, `ETag` = SHA-256, `304` on `If-None-Match` |
| `/api/health` | `{ status, checks: { database, n8n } }`; `503` when the database is down (n8n is informational) |

Unknown or malformed IDs return `404 not_found`.

## Write API

| Route | Body | Result |
|---|---|---|
| `POST /api/projects` | `{ projectName, clientName, designBrief, ideaCount }` (JSON, max 64 KB; brief ≤ 4,000 chars; `ideaCount` 2–5) | `201 { project }` and concept generation starts. `422 validation_failed` (with `fields`), `413 payload_too_large`, `503 automation_unavailable`, `502 automation_contract` |

Everything else the UI does is a **Server Action** (`apps/web/src/app/projects/actions.ts`). Each one
validates its IDs (UUID), checks that the concept belongs to the project, and maps workflow errors to a
short message (`{ ok: false, message }`):

| Action | What it does |
|---|---|
| `createProjectAction` | Create the project (n8n `project-create`) and start concept generation |
| `generateIdeasAction(projectId, count)` | Generate concepts / "More ideas" / retry after a failure |
| `selectConceptAction`, `rejectConceptAction`, `restoreConceptAction` | Approve, reject, undo (nothing is deleted) |
| `retryConceptImageAction(projectId, conceptId)` | Re-run one failed concept image |
| `refineConceptAction(projectId, conceptId, baseRevisionId, feedback)` | Refine the version the client is looking at; refused if a newer version exists or a refinement is running |
| `retryRefinementAction(projectId, conceptId, revisionId)` | Retry the newest failed revision in place |
| `chooseConceptVersionAction(projectId, conceptId, revisionId \| null)` | "Use this version" (current version + approve) |
| `finalizeDesignAction(projectId, conceptId, revisionId \| null)` | Create the canonical final design (idempotent) and start the four views |
| `generateViewsAction(projectId)` | Start the views if they didn't start, or retry every failed view |
| `regenerateViewAction(projectId, viewType)` | "Regenerate this view" (FRONT, BACK, LEFT or RIGHT) |
| `approveViewsAndDeliverAction(projectId)` | Approve all four views, then start the Google Drive delivery |
| `deliverToDriveAction(projectId)` | Start / retry the Drive delivery (idempotent) |
| `retryProjectAction(projectId)` | Retry a failed project step |
| `loginAction`, `logoutAction` | Studio access gate |

Server Action bodies are limited to 1 MB (Next.js default).

## Internal API (n8n → app)

| Route | Body | Result |
|---|---|---|
| `POST /api/internal/assets` | `{ project_id, kind: CONCEPT\|REVISION\|VIEW\|REFERENCE, data_base64, provider?, model?, provider_request_id?, provider_url?, prompt? }` | `201 { asset_id, url, mime_type, bytes, width, height }`. The image is checked by magic bytes (PNG/JPEG/WebP only), max 20 MB, stored content-addressed (`<project>/<sha256>.<ext>`, atomic write). `422 invalid_image` / `project_not_found`, `413` if the body is too large |
| `GET /api/internal/assets/:assetId[?format=png]` | — | `{ asset_id, mime_type, sha256, data_base64 }`. `format=png` converts losslessly (used for the Drive package) |

## n8n webhooks (app → n8n)

All `POST`, JSON, header `X-Webhook-Token`. Long jobs answer `202` at once and settle state in the database;
the app polls `/status`. Details: `docs/N8N-WORKFLOWS.md`.

| Webhook | Body | Answers |
|---|---|---|
| `3d-studio/project-create` | `{ project_name, client_name, design_brief }` | `201 { project_id, status, created_at }`, `422` |
| `3d-studio/concepts-generate` | `{ project_id, concept_count, config }` | `202`, `409 invalid_state`, `422` |
| `3d-studio/concept-image-generate` | `{ concept_id, retry?, config }` | `202`, `409 image_in_progress / image_already_done / invalid_state`, `422` |
| `3d-studio/concept-refine` | `{ project_id, concept_id, revision_id, config }` | `202`, `409 invalid_state / refinement_in_progress / no_base_image`, `422` |
| `3d-studio/views-generate` | `{ project_id, final_design_id, view_types?: [FRONT…], config }` | `202`, `409 views_in_progress / not_retryable / nothing_to_do / invalid_state`, `422` |
| `3d-studio/view-image-generate` | `{ view_id, config }` (called by `views-generate`) | `202`, `409`, `422` |
| `3d-studio/drive-export` | `{ project_id, config: { drive_mode, drive_parent_folder_id? } }` | `202`, `200 already_completed`, `409 export_in_progress / invalid_state`, `422` |

`config` carries non-secret settings only: provider mode, model IDs, mock scenarios. Keys never travel
in requests; they live in n8n credentials.

## Database functions

Every state change goes through a PostgreSQL function (migrations `0003`–`0013`). These functions are the
contract between n8n and the database. Triggers enforce the state machine underneath, so even direct SQL
can't create an illegal transition.

| Function | Used by |
|---|---|
| `start_concept_generation`, `save_concept_texts`, `finish_concept_generation`, `fail_concept_generation` | concepts workflow |
| `start_concept_image`, `complete_concept_image`, `fail_concept_image` | concept image workflow |
| `start_refinement`, `retry_refinement`, `complete_refinement`, `fail_refinement`, `use_concept_version` | app + refine workflow |
| `finalize_design`, `start_view_generation`, `save_view_prompts`, `start_view_image`, `complete_view_image`, `fail_view_image`, `fail_view_preparation`, `finish_view_generation`, `approve_all_views` | app + views workflows |
| `start_drive_export`, `save_drive_item`, `complete_drive_export`, `fail_drive_export` | Drive workflow |
