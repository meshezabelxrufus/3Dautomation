# Development Guide

How to install, configure, run and inspect the local stack for the 3D Design Studio (Milestone 1).

| Document | Contents |
|---|---|
| [`MILESTONE-1-ARCHITECTURE.md`](./MILESTONE-1-ARCHITECTURE.md) | Architecture, decisions, data model |
| [`N8N-WORKFLOWS.md`](./N8N-WORKFLOWS.md) | Every workflow, conventions, credentials, operating |
| [`API.md`](./API.md) | Read API, Server Actions, internal API, webhooks, DB functions |
| [`GOOGLE-DRIVE.md`](./GOOGLE-DRIVE.md) | Drive structure, idempotency, OAuth setup, test double |
| [`TESTING.md`](./TESTING.md) | Tests, mock scenarios, audit results, known issues and limitations |

## Quick start (fresh machine)

```bash
sh scripts/init-env.sh                           # creates .env with generated secrets (upgrading: --add-missing)
pnpm install
docker compose up -d --build                     # postgres, migrate, n8n, web (+ fake-drive with the drive-test profile)
```

1. Open n8n at http://localhost:5680, create the owner account, then **Settings → n8n API → Create an API key** and
   put it in `.env` as `N8N_DEPLOY_API_KEY_LOCAL`.
2. Keys: set `ANTHROPIC_API_KEY` and either `GEMINI_API_KEY` (`IMAGE_PROVIDER=gemini`) or `POLLINATIONS_API_KEY`
   (`IMAGE_PROVIDER=pollinations`) in `.env`, or enter them later in the n8n credentials. For a run without any
   keys use `AI_PROVIDER_MODE=mock`.
3. Google Drive: follow [`GOOGLE-DRIVE.md`](./GOOGLE-DRIVE.md), or use the test double (`COMPOSE_PROFILES=n8n,drive-test`,
   `DRIVE_MODE=test`).
4. `pnpm n8n:credentials && pnpm n8n:deploy`, then `docker compose up -d` (picks up `.env` changes).
5. Set `STUDIO_ACCESS_PASSWORD` if the app is reachable from anywhere but this machine.
6. `sh scripts/verify-stack.sh`, then open http://localhost:3100.

## Contents

1. [Stack overview](#1-stack-overview)
2. [Prerequisites](#2-prerequisites)
3. [Installation](#3-installation)
4. [Environment setup](#4-environment-setup)
5. [Starting the stack](#5-starting-the-stack)
6. [Stopping the stack](#6-stopping-the-stack)
7. [Viewing logs](#7-viewing-logs)
8. [Accessing n8n](#8-accessing-n8n)
9. [Database access](#9-database-access)
10. [Frontend access](#10-frontend-access)
11. [Verifying the stack](#11-verifying-the-stack)
12. [Frontend development with hot reload](#12-frontend-development-with-hot-reload)
13. [Using an external n8n instead](#13-using-an-external-n8n-instead)
14. [Data, backups and resets](#14-data-backups-and-resets)
15. [Troubleshooting](#15-troubleshooting)
16. [Database schema and migrations](#16-database-schema-and-migrations)
17. [Running the tests](#17-running-the-tests)
18. [Frontend](#18-frontend)
19. [n8n workflows](#19-n8n-workflows)
20. [Concept generation with Claude](#20-concept-generation-with-claude)

---

## 1. Stack overview

| Service | Image | URL from your machine | Inside Docker network | Persistent volume |
|---|---|---|---|---|
| `web` | built from `apps/web/Dockerfile` (Next.js 16, standalone) | http://localhost:3100 | `http://web:3000` | `assets_data` → `/data/assets` |
| `n8n` | `n8nio/n8n:2.32.6` | http://localhost:5680 | `http://n8n:5678` | `n8n_data` → `/home/node/.n8n` |
| `postgres` | `postgres:16-alpine` | `localhost:5434` | `postgres:5432` | `pg_data` → `/var/lib/postgresql/data` |
| `fake-drive` (profile `drive-test`, development only) | `node:22-alpine` + `infra/fake-drive/server.mjs` | http://localhost:4010 | `http://fake-drive:4010` | none (in memory) |
| `migrate` (one-shot) | `migrator` target of `apps/web/Dockerfile` | — | — | — |

- **Postgres** hosts two isolated databases:
  - `app`, owned by `app_user`, for the web app;
  - `n8n`, owned by `n8n_user`, for n8n.

  Neither role can connect to the other's database.
- **n8n** stores its workflows, credentials and executions in Postgres. It encrypts stored credentials with `N8N_ENCRYPTION_KEY` from `.env`.
- **Ports** are bound to `127.0.0.1` only. The defaults avoid 3000, 5432 and 5678, which other local stacks commonly use.
- **`migrate`** applies pending database migrations, then exits. `web` only starts after it succeeds.
- **Compose project name** is `three-d-automation`, so containers, volumes and the network are prefixed with it and never collide with other stacks.

## 2. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Docker Desktop (or Docker Engine + Compose v2) | Docker ≥ 24, Compose ≥ 2.20 | `docker --version && docker compose version` |
| Node.js | ≥ 22 | `node --version` |
| pnpm | 9.x (pinned in `package.json` → `packageManager`) | `corepack enable && pnpm --version` |
| openssl | any | `openssl version` (used to generate secrets) |
| git | any | |

Node and pnpm are only needed for host-side work: lint, typecheck, hot-reload dev. The Docker stack builds the web app inside the image.

> Keep the repository **outside** cloud-synced folders (Google Drive, iCloud Desktop/Documents, Dropbox). Syncing `node_modules`, `.next` and `.git` is slow and can corrupt files.

## 3. Installation

```bash
git clone <repo-url> the-3d-automation
```

```bash
cd the-3d-automation
```

```bash
corepack enable
```

```bash
pnpm install
```

## 4. Environment setup

Create your local `.env` from the template. Each `__GENERATE__` placeholder becomes a unique random secret:

```bash
sh scripts/init-env.sh
```

(or `pnpm env:init`)

- `.env` is created with mode `600` and is **git-ignored**. Never commit it. Only `.env.example` (placeholders, no real values) is tracked.
- The script refuses to overwrite an existing `.env`, because it holds the n8n encryption key and database passwords.
- **Back up `N8N_ENCRYPTION_KEY`** (e.g. in a password manager). If it is lost or changed, n8n can no longer decrypt its stored credentials and refuses to start.
- AI provider keys (Anthropic, Gemini) and Google Drive OAuth do **not** go in `.env`. They are entered as n8n credentials in a later step.

Main variables (full list and comments in `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `COMPOSE_PROFILES` | `n8n` | Starts the project's own n8n. Set it empty to use an external n8n (§13) |
| `WEB_HOST_PORT` / `N8N_HOST_PORT` / `POSTGRES_HOST_PORT` | `3100` / `5680` / `5434` | Host ports |
| `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `N8N_DB_PASSWORD` | generated | Database passwords |
| `N8N_ENCRYPTION_KEY` | generated | n8n credential encryption |
| `N8N_WEBHOOK_BASE_URL` | `http://n8n:5678` | How the web app reaches n8n |

## 5. Starting the stack

Build images (first run, or after code changes) and start everything in the background:

```bash
docker compose up -d --build
```

Without code changes, plain `docker compose up -d` is enough. `pnpm stack:up` runs the build variant.

Check status. All services should show `(healthy)` within about 30–60 s:

```bash
docker compose ps
```

The first start takes longer because Postgres initialises the `app` and `n8n` databases (`infra/postgres/init/01-create-databases.sh`) and n8n runs its schema migrations.

## 6. Stopping the stack

Stop and remove the containers. **Data is kept** in the named volumes:

```bash
docker compose down
```

To pause containers without removing them:

```bash
docker compose stop
```

> ⚠️ `docker compose down -v` **deletes all volumes**: databases, n8n workflows/credentials and generated assets. Only use it to deliberately reset (§14).

## 7. Viewing logs

All services, following:

```bash
docker compose logs -f --tail=100
```

A single service (`web`, `n8n` or `postgres`):

```bash
docker compose logs -f n8n
```

## 8. Accessing n8n

Open http://localhost:5680.

- **First visit:** n8n asks you to create the **owner account** for this local instance. Use your own email and a strong password. This account exists only in your local `n8n` database.
- **Webhooks** for this instance are served under `http://localhost:5680/webhook/...` from the host and `http://n8n:5678/webhook/...` from the web container.
- **Health endpoints:** `http://localhost:5680/healthz` (process up) and `http://localhost:5680/healthz/readiness` (database connected).
- **Instance settings** (all in `docker-compose.yml`):
  - telemetry off, community packages off, `$env` access blocked in nodes;
  - binary data stored on the filesystem volume;
  - executions pruned after 14 days.

## 9. Database access

Connection details (passwords are in your `.env`):

| | App database | n8n database |
|---|---|---|
| Host / port (from your machine) | `localhost` / `5434` | `localhost` / `5434` |
| Database | `app` | `n8n` |
| User | `app_user` | `n8n_user` |
| Password | `APP_DB_PASSWORD` | `N8N_DB_PASSWORD` |
| URL | `postgres://app_user:<APP_DB_PASSWORD>@localhost:5434/app` | — |

Interactive `psql` inside the container (no local client needed):

```bash
docker compose exec postgres psql -U postgres -d app
```

As the application role:

```bash
docker compose exec postgres sh -c 'PGPASSWORD="$APP_DB_PASSWORD" psql -h 127.0.0.1 -U "$APP_DB_USER" -d "$APP_DB_NAME"'
```

GUI clients (TablePlus, DBeaver, pgAdmin…) connect with the table values above.

The n8n database is managed by n8n. Read it if you need to, but don't modify it by hand.

## 10. Frontend access

| What | URL |
|---|---|
| Web app | http://localhost:3100 |
| Health / readiness | http://localhost:3100/api/health |

`/api/health` returns `200` with `{"status":"ok"}` when the database is reachable. The `n8n` check is informational: if n8n is down, the web app stays up and reports `"n8n":{"status":"error"}`.

Only an infrastructure placeholder page exists so far. Product features come in later steps.

## 11. Verifying the stack

Run every infrastructure check: compose validity, container health, HTTP health, database connectivity and isolation, n8n availability, secret hygiene.

```bash
sh scripts/verify-stack.sh
```

Also prove that data survives `docker compose down` → `docker compose up -d` (this restarts the stack):

```bash
sh scripts/verify-stack.sh --persistence
```

Code quality checks (host):

```bash
pnpm lint
```

```bash
pnpm typecheck
```

## 12. Frontend development with hot reload

For fast UI iteration, run Next.js on your machine against the Dockerised Postgres and n8n. The dev server uses port **3101**, so it can run next to the `web` container on 3100.

1. Create `apps/web/.env.local` (git-ignored). Use the `APP_DB_PASSWORD` value from `.env`:

   ```dotenv
   DATABASE_URL=postgres://app_user:<APP_DB_PASSWORD>@localhost:5434/app
   N8N_WEBHOOK_BASE_URL=http://localhost:5680
   N8N_WEBHOOK_TOKEN=<N8N_WEBHOOK_TOKEN from .env>
   N8N_CALLBACK_TOKEN=<N8N_CALLBACK_TOKEN from .env>
   ```

   Generated images are stored by whichever app n8n calls back. To have them land in the dev server's
   storage (`apps/web/.data/assets`) instead of the `web` container's volume, set
   `N8N_APP_BASE_URL=http://host.docker.internal:3101` in `.env` and run `pnpm n8n:deploy`. Set it back to
   `http://web:3000` afterwards.

2. Start the dev server:

   ```bash
   pnpm dev
   ```

3. Open http://localhost:3101.

Optionally stop the containerised web app while developing:

```bash
docker compose stop web
```

## 13. Using an external n8n instead

The stack can point the web app at an n8n that runs elsewhere, e.g. a shared local test instance or the production VPS. See architecture §6.6–6.7 for the separation rules that apply there.

1. In `.env`, set `COMPOSE_PROFILES=` (empty) so the project n8n isn't started.
2. In `.env`, set `N8N_WEBHOOK_BASE_URL`. Examples:
   - `http://host.docker.internal:5678` for an n8n published on the host's port 5678;
   - the VPS's internal URL.
3. Recreate the web container:

```bash
docker compose up -d
```

Our Compose file never starts, stops or reconfigures an external n8n.

## 14. Data, backups and resets

| Data | Lives in | Survives `down` | Survives `down -v` |
|---|---|---|---|
| App database | volume `three-d-automation_pg_data` | ✅ | ❌ |
| n8n workflows / credentials / executions | `pg_data` (database) + `three-d-automation_n8n_data` (config, binary data) | ✅ | ❌ |
| Generated images (later steps) | volume `three-d-automation_assets_data` | ✅ | ❌ |

Back up both databases from the running stack:

```bash
docker compose exec -T postgres pg_dump -U postgres -d app > backup-app.sql
```

```bash
docker compose exec -T postgres pg_dump -U postgres -d n8n > backup-n8n.sql
```

An n8n backup is only usable together with the same `N8N_ENCRYPTION_KEY`.

**Full reset**, which deletes everything local:

```bash
docker compose down -v
```

Then run `docker compose up -d` again. The databases are re-created by the init script, and n8n will ask for a new owner account.

## 15. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Bind for 127.0.0.1:3100 failed: port is already allocated` | Another process uses the port. Change `WEB_HOST_PORT` / `N8N_HOST_PORT` / `POSTGRES_HOST_PORT` in `.env`, then `docker compose up -d` |
| `required variable … is missing a value` | `.env` is missing or incomplete. Run `sh scripts/init-env.sh`, or compare with `.env.example` |
| n8n logs `Mismatching encryption keys` and keeps restarting | `N8N_ENCRYPTION_KEY` changed after n8n was first initialised. Restore the original key. Only if the local n8n data is disposable: `docker compose down -v` |
| Changed DB passwords in `.env` but services can't log in | The init script only runs on an **empty** `pg_data` volume. Either reset (`down -v`) or change the role's password with `ALTER ROLE … PASSWORD …` via `psql` |
| n8n logs `Failed to start Python task runner … Python 3 is missing` | Expected and harmless. The official image has no Python; the JavaScript Code runner is active and is all this project uses |
| n8n logs a `pg` `DeprecationWarning` about `client.query()` | Comes from n8n's internals. Harmless |
| `web` is `unhealthy` | `docker compose logs web` and `curl localhost:3100/api/health`. Usually Postgres is not ready or `DATABASE_URL` credentials don't match the initialised database |
| Docker build fails at `pnpm install --frozen-lockfile` | `pnpm-lock.yaml` is out of date. Run `pnpm install` on the host and commit the lockfile |
| `migrate` exited with a non-zero code and `web` doesn't start | `docker compose logs migrate`. Usually a migration error or a database connection problem. Fix it, then `docker compose up -d` again |
| Builds fail with `ENOSPC` / Docker Desktop stops | The disk is full. Repeated image builds grow Docker's build cache: `docker builder prune` (cache only, no data) and `docker image prune` (dangling images). Check with `docker system df` |
| Every page redirects to `/login` | `STUDIO_ACCESS_PASSWORD` is set: sign in with it. `503 misconfigured` means `STUDIO_SESSION_SECRET` is missing or shorter than 32 characters |
| Sign-in loops back to `/login` behind HTTPS | Set `SESSION_COOKIE_SECURE=true` or make the proxy send `X-Forwarded-Proto: https` |
| A job shows "Generating…" for a long time | Open/refresh the project: lazy recovery fails jobs whose n8n execution died (concepts 26 min, images/refinements 11 min, views 31 min, Drive 21 min) and offers a retry. Check the execution in the n8n UI |
| "The studio's database is temporarily unavailable" | Postgres is down or restarting: `docker compose ps`, `docker compose logs postgres`. The app recovers by itself |

## 16. Database schema and migrations

| What | Where |
|---|---|
| Schema (tables, enums, FKs, indexes) | `apps/web/src/db/schema.ts` (Drizzle ORM) |
| Workflow statuses, transitions, event types | `apps/web/src/server/domain/workflow-states.ts` |
| Workflow operations (status change + event in one transaction) | `apps/web/src/server/workflow/` |
| SQL migrations | `apps/web/drizzle/` (`0000` generated from the schema, `0001` triggers and transition seed) |

Tables: `projects`, `concepts`, `revisions`, `final_designs`, `final_views`, `project_events`, plus the `workflow_status_transitions` reference table. Architecture §4.1 and §5.2 describe the model.

**The database is authoritative for workflow state.** Triggers reject any status change that isn't an allowed transition, as well as cross-step violations (e.g. uploading before all four views are approved), even for raw SQL. Change state through the functions in `src/server/workflow/`, never by writing `status` directly.

Migrations run automatically through the `migrate` service on `docker compose up`. To run them from the host (uses `apps/web/.env.local`, §12):

```bash
pnpm --filter @three-d/web db:migrate
```

To change the schema:

1. Edit `apps/web/src/db/schema.ts`.
2. Generate a migration:

   ```bash
   pnpm --filter @three-d/web db:generate
   ```

3. Review the generated SQL in `apps/web/drizzle/`, then apply it with `db:migrate`.

For triggers, functions or data changes, create an empty custom migration and write the SQL by hand:

```bash
pnpm --filter @three-d/web exec drizzle-kit generate --custom --name <name>
```

**Changing a state transition** needs both an edit to `workflow-states.ts` and a new migration that updates `workflow_status_transitions`. The test `tests/db/state-machine-sync.test.ts` fails if the two disagree.

Never edit a migration that has already been applied anywhere. Add a new one instead.

## 17. Running the tests

The tests need the Postgres container running (`docker compose up -d postgres`). Each run creates a temporary database (`app_test_<random>`), applies the real migrations as `app_user`, runs the tests and drops the database afterwards. Your development data is never touched. Connection details come from the root `.env`.

```bash
pnpm --filter @three-d/web test
```

| Test file | Covers |
|---|---|
| `tests/domain/workflow-states.test.ts` | Pure state-machine rules |
| `tests/db/migrations.test.ts` | Tables, triggers, indexes, re-running migrations |
| `tests/db/state-machine-sync.test.ts` | TypeScript transitions and enums equal the database |
| `tests/db/crud.test.ts` | Create/read/update/delete for every table, column checks |
| `tests/db/foreign-keys.test.ts` | FK rejections, cross-project FKs, cascades |
| `tests/db/state-transitions.test.ts` | Invalid transitions and guards, via raw SQL and via services |
| `tests/workflow/lifecycle.test.ts` | Full brief → COMPLETED lifecycle with the exact event sequence, failure and retry paths |
| `tests/db/concept-*`, `revision-chain`, `final-views`, `drive-delivery` | The Step 5–9 database functions (see `docs/TESTING.md`) |
| `tests/n8n/*` | The logic n8n runs (`n8n/lib/*.cjs`) and the workflow JSON conventions |
| `tests/http/*` | Access gate and API error mapping |

## 18. Frontend

**Screens**

| URL | Screen |
|---|---|
| `/projects` | All projects: cover render, client, status, last update, stage progress |
| `/projects/new` | Create a project: name, client, natural-language brief, number of ideas, **Generate ideas** |
| `/projects/<id>` | Workspace. Shows the right view for each state: empty, generating, concepts ready, refining, finalizing, generating views, view review, uploading, completed, error |
| `/projects/<id>?concept=<id>` | One concept up close: large render, details, refine, history, approve as final design |

**Demo data.** To see every workspace state without AI, load nine demo projects (dev only; replaces previous demo projects, leaves everything else alone):

```bash
pnpm --filter @three-d/web db:seed:demo
```

Demo projects have " · Demo" after the client name and use placeholder renders from `apps/web/public/demo/`.

**Asynchronous by design.** AI steps take minutes, so the browser never waits on them:

1. A button calls a Server Action (`src/app/projects/actions.ts`). It changes state in the database and returns at once. Dispatching the n8n job will be added in `src/server/commands/projects.ts`.
2. The workspace polls `GET /api/projects/<id>/status`: every 2.5 s while the project is busy, every 20 s otherwise, and not at all in a background tab.
3. When the status's `changeToken` changes (for example, a concept image arrived), the workspace refetches project, concepts, revisions and views.

Everything shown comes from the database status, not from browser flags.

**Read API** (JSON, used by the polling hooks and available to other clients):

| Endpoint | Returns |
|---|---|
| `GET /api/projects` | Project summaries |
| `POST /api/projects` | Create + start generation (validated; 422 with field messages) |
| `GET /api/projects/<id>` | Project |
| `GET /api/projects/<id>/status` | Status, busy flag, change token (for polling) |
| `GET /api/projects/<id>/concepts` | Concepts |
| `GET /api/projects/<id>/revisions` | Revisions of all concepts |
| `GET /api/projects/<id>/views` | Final design + current four views |

**Code map**

| Path | Contents |
|---|---|
| `src/components/studio/` | Product components: `ProjectCard`, `ProjectStatus`, `DesignBriefForm`, `ConceptCard`, `ConceptGallery`, `RevisionHistory`, `RefinementInput`, `FinalViewGrid`, `GenerationStatus`, `ErrorState`, `LoadingState`, `ApprovalDialog`, plus the workspace parts |
| `src/components/ui/` | Primitives: `Button`, `DesignImage`, `Field`, `Skeleton`, `Spinner` |
| `src/lib/api/` | DTO types, typed fetchers, TanStack Query hooks |
| `src/lib/workflow-ui.ts` | Labels, tones, stages and busy flags per status |
| `src/server/queries/` | Read models behind the pages and the GET API |
| `src/app/globals.css` | Design tokens (light/dark), type scale, materials, accessibility preferences |

**Design system.** It follows the project's `apple-design` skill (`.claude/skills/apple-design`):
- the system font with size-specific tracking;
- hairline structure instead of heavy shadows, and one accent colour;
- instant press feedback;
- critically damped springs (Motion) for the dialog and gallery entrances;
- a translucent header.

It respects reduced-motion, reduced-transparency and increased-contrast settings, and works from phone width up.

## 19. n8n workflows

Project creation runs through n8n:

```
browser → Server Action (web) → POST http://n8n:5678/webhook/3d-studio/project-create
        (header X-Webhook-Token)  → validate → INSERT project + PROJECT_CREATED event (one statement)
        → 201 { project_id, status, created_at } → web starts concept generation → /projects/<id>
```

- **No browser-to-n8n traffic:** the browser never calls n8n, and the webhook token stays on the server (`N8N_WEBHOOK_TOKEN`).
- **One service layer:** server code calls n8n only through `apps/web/src/server/n8n/`. `client.ts` handles the token, timeout and typed errors; `projects.ts` covers the project-create contract.
- **Failures are user-safe:**

  | Situation | Server returns | The person sees |
  |---|---|---|
  | n8n down, workflow not published, or database unreachable | `503` | "Nothing was saved, try again" (form values kept) |
  | Invalid input | `422` | Field messages |

  A database failure inside the workflow is also recorded as a **failed execution** in n8n.

**First-time setup on a fresh stack:**

1. Open http://localhost:5680 and create the n8n owner account.
2. In n8n, go to Settings → n8n API, create a key, and put it in `.env` as `N8N_DEPLOY_API_KEY_LOCAL`.
3. Create the n8n credentials from `.env`:

   ```bash
   pnpm n8n:credentials
   ```

4. Deploy and publish the workflows:

   ```bash
   pnpm n8n:deploy
   ```

5. Run `sh scripts/verify-stack.sh`. It checks that the webhook is deployed and rejects calls without the token.

See `n8n/README.md` for the rules and options.

| Symptom | Fix |
|---|---|
| Create fails with "automation service didn't respond", and n8n logs show nothing | The workflow isn't published (404) or the token differs (403). Run `pnpm n8n:status`, then `pnpm n8n:credentials && pnpm n8n:deploy` |
| An execution fails with `database_unavailable` | n8n can't reach Postgres. Check `N8N_APP_DB_HOST` and re-run `pnpm n8n:credentials` |
| `N8N_WEBHOOK_TOKEN` was changed in `.env` | Re-run `pnpm n8n:credentials` and recreate the web container (`docker compose up -d`) |

## 20. Concept generation with Claude

"Generate ideas" (and "More ideas" or "Retry") calls the n8n workflow `3d-studio/concepts-generate`.

```
web → n8n: start_concept_generation()  (project → GENERATING_CONCEPTS + event)
    → 202 straight away (the workspace shows "Writing concepts…" and polls)
    → Claude (structured JSON, up to 3 attempts) → validate
    → save_concept_texts()           (concepts appear as GENERATING; project stays GENERATING_CONCEPTS)
    → one image job per concept (§21), all in parallel → wait until none is GENERATING
    → finish_concept_generation()    (leftovers FAILED, event, project → CONCEPT_REVIEW)
    or fail_concept_generation()     (Claude failed: project → FAILED with a client-safe reason + event)
```

- **Model:** `CLAUDE_MODEL` (default `claude-sonnet-5-5`) with effort `CLAUDE_EFFORT` (default `high`). JSON output is constrained with `output_config.format` (`json_schema`). Refusal fallback is on (`fallbacks: "default"`).
- **Reliability:** each Claude answer goes through four stages:
  1. **Parsing:** the text is never trusted. Fences, surrounding text and trailing commas are handled.
  2. **Local repair:** key names and list formats are normalised.
  3. **Validation:** every field, the concept count, and duplicate or near-identical concepts.
  4. **Structured repair:** if invalid, Claude is shown its own output plus the errors.

  Overloaded or failed API calls are retried with backoff. Auth errors and refusals fail immediately.
- **Database state:** it changes only through the three database functions (migration 0003), so it's atomic and rule-checked. A double click can't start two runs. A generation n8n never finished (crash or restart) is marked FAILED after 26 minutes, the next time the project is opened.
- **Images:** see §21.

**API key:** enter it in n8n, in the credential **"3D Studio — Anthropic"**. Alternatively set `ANTHROPIC_API_KEY` in `.env` and run `pnpm n8n:credentials`.

**Mock mode (no API cost):** set these in `.env` (Docker) or `apps/web/.env.local` (dev server):

```dotenv
AI_PROVIDER_MODE=mock
AI_MOCK_SCENARIO=ok
```

Other `AI_MOCK_SCENARIO` values reproduce failures:

| Scenario | Outcome |
|---|---|
| `repairable` | Fixed locally, saved on attempt 1 |
| `malformed_then_ok`, `too_similar_then_ok`, `truncated_then_ok`, `api_error_then_ok` | Saved on attempt 2 |
| `always_malformed`, `api_down`, `transport_error` | Fail after 3 attempts |
| `auth_error`, `refusal` | Fail immediately |

Each n8n execution is listed in the n8n UI. A failed generation also shows as a **failed** execution there, with the technical detail.

## 21. Concept images with Nano Banana

Every concept gets its own n8n execution of `[3D Studio] M1 · Concept image — generate`
(`3d-studio/concept-image-generate`). Nano Banana (Gemini `generateContent`, model `IMAGE_MODEL`, default
`gemini-3.1-flash-image`) is called **only from n8n**. The key lives in the n8n credential
**"3D Studio — Gemini"**, never in the web app or the browser.

```
start_concept_image()      claim the job (GENERATING; a retry moves FAILED → GENERATING) → 202
→ Nano Banana (up to 3 attempts; 429/5xx/no image retried, auth/blocked fail at once)
→ POST {app}/api/internal/assets   n8n uploads the bytes (Authorization: Bearer N8N_CALLBACK_TOKEN)
                                   the app validates PNG/JPEG/WebP, stores it content-addressed, returns asset_id
→ complete_concept_image()  concept READY, image_url = /api/assets/<asset_id>, event
or fail_concept_image()     concept FAILED with a client-safe reason, event
```

- **Isolation:** one failed image never affects the others. If concept 3 of 5 fails, 1, 2, 4 and 5 stay
  READY, 3 shows its reason and a **Retry image** button. Retry runs the same workflow for that concept only.
- **Storage:** images are never served from provider URLs. The `assets` table records storage key, size,
  dimensions, SHA-256, provider, model, provider request id (`responseId`), prompt and time. Files live in
  `ASSET_STORAGE_DIR` (Docker volume `assets_data`; `apps/web/.data/assets` for the dev server) and are served
  by `GET /api/assets/<id>` with immutable caching.
- **Recovery:** an image job or refinement whose n8n execution died is marked FAILED (retryable) after
  11 minutes, the next time the project is read.
- **Deploy-time URLs:** n8n reaches the app at `N8N_APP_BASE_URL` (default `http://web:3000`) and itself at
  `N8N_SELF_URL` (default `http://127.0.0.1:5678`). Both are baked into the workflows by `pnpm n8n:deploy`,
  so a caller can't redirect n8n (or the callback token) elsewhere.

**Concept actions** (gallery card and detail view; nothing is ever deleted):

| Action | Effect |
|---|---|
| Approve | READY → SELECTED (click again to undo) |
| Reject | → REJECTED; the card dims and offers **Restore** (→ READY) |
| Refine | Opens the concept with the feedback field focused (see §22) |
| Approve as final design | In the detail view, once an image exists |

**API key:** enter it in n8n, in the credential **"3D Studio — Gemini"**, or set `GEMINI_API_KEY` in `.env`
and run `pnpm n8n:credentials`. Without a key every image fails with "check the Gemini API key", and the
concepts stay usable.

**Testing without a Gemini key (Pollinations):** Gemini's image models have no free API tier. To exercise
the real flow (Claude concepts, rendered images, storage, retry, refinement edits) without one, switch the
image provider to [Pollinations](https://pollinations.ai). It needs a key from
https://enter.pollinations.ai/keys (new accounts get a free allowance; images cost fractions of a "pollen").

```dotenv
IMAGE_PROVIDER=pollinations
POLLINATIONS_API_KEY=sk_...
# optional, default black-forest-labs/flux.2-klein-4b (generation + edits)
POLLINATIONS_MODEL=
```

Then run `pnpm n8n:credentials` (syncs the key to the n8n credential **"3D Studio — Pollinations"**) and
recreate the web container (`docker compose up -d web`), or restart the dev server with the same settings in
`apps/web/.env.local`. No workflow redeploy needed: the provider travels with each request.

Concepts use `POST https://gen.pollinations.ai/v1/images/generations`; refinements use `/v1/images/edits` with
the current image, so they're real edits like Nano Banana's. Images are recorded with provider
`pollinations` and the model id. When the Pollinations balance runs out, images fail with "balance is used
up" (retryable after a top-up). Switch back with `IMAGE_PROVIDER=gemini` once you have a Gemini key.

**Mock mode:** with `AI_PROVIDER_MODE=mock`, `AI_IMAGE_MOCK_SCENARIO` picks the image behaviour:

| Scenario | Outcome |
|---|---|
| `ok` (default) | Every image renders |
| `slow` | Each image takes ~12 s |
| `fail:<n>` | Concept *n* fails; **Retry image** then succeeds |
| `fail_always:<n>` | Concept *n* fails, retries too |
| `api_error_then_ok`, `no_image_then_ok` | Rendered on attempt 2 |
| `api_down` | Fails after 3 attempts |
| `blocked`, `auth_error`, `model_not_found` | Fail at once |

Refinement mock scenarios (via `AI_MOCK_SCENARIO`): `refine_malformed_then_ok`, `refine_refusal`.

## 22. Refinement and the revision chain

Opening a concept shows its **current version** large, the description, "What would you like to change?" and
the **revision history**: Revision 0 (the original image), then every refinement in order. Older versions can be
viewed at any time; nothing is ever overwritten or deleted.

```
web (project_id, concept_id, version the client was looking at, feedback)
→ start_refinement()   validates all of it in one transaction, creates revision N+1 (GENERATING) linked to the
                       current version (base_revision_id); concept + project → REFINING
→ n8n `3d-studio/concept-refine` (project_id, concept_id, revision_id; n8n checks they belong together)
→ load the current version: its image, its full prompt, the design record and the chain of earlier refinements
→ Claude sees the current image + all of that and returns, as strict JSON:
     summary · changes (what must change) · preserve (what must stay, named concretely)
     edit_prompt (for the image model) · revised_prompt (complete description of the new version)
→ the image model edits the current image with edit_prompt
→ complete_refinement()  revision READY with feedback, interpretation, prompt, image; it becomes the current
                         version; concept READY, project → CONCEPT_REVIEW
   or fail_refinement()  revision FAILED with a client-safe reason; current version unchanged; project → CONCEPT_REVIEW
```

- **Guarding against the wrong concept or version:** every refinement carries `project_id`, `concept_id` and the
  version the client was looking at. The database refuses a concept from another project, a version that is no
  longer current ("a newer version exists"), and a second refinement while one runs (double clicks, two tabs).
  Composite foreign keys keep `base_revision_id` and `active_revision_id` inside the same concept.
- **What changes vs what stays:** Claude must list concrete `preserve` items (e.g. "dark gunmetal armour
  plates"); a vague "everything else" is rejected and repaired. The next refinement starts from the previous
  `revised_prompt`, so earlier changes are never undone by accident.
- **Use this version** makes the viewed version current and approves the concept; the next refinement branches
  from it (the other branch is kept). **Continue refining** jumps to the feedback field. **Approve as final**
  uses the current version.
- **Failure and retry:** a failed revision shows its reason and **Retry** (same feedback, same base version,
  same revision number). Only the newest revision can be retried, and only while its base is still current.
  A refinement whose n8n run died is failed after 11 minutes (lazy recovery).
- **Stored per revision:** number, base version, feedback, Claude's interpretation (JSON), the prompt the image
  model received, the image (asset), timestamp and status.

Mock scenarios (`AI_MOCK_SCENARIO`): `refine_malformed_then_ok`, `refine_vague_preserve_then_ok`,
`refine_down_once` (the first run of every revision fails; **Retry** succeeds), `refine_down`, `refine_refusal`.

## 23. Final design and the four views

**Finalize.** In a concept's view, "Finalize this version…" (or "Finalize design…" once approved) opens a
confirmation with the exact image, concept, revision number and description. **Finalize design** runs
`finalize_design()`: one transaction creates the final design (`project_id`, `approved_concept_id`,
`approved_revision_id`, `master_image` + `master_asset_id`), marks the concept FINAL and moves the project to
FINALIZING. That record is the **canonical design**: a trigger refuses any later change to its master image or
approved concept/revision. Repeating the request (double click, two tabs) returns the same final design.

**Four views** (`[3D Studio] M1 · Views — generate`, `3d-studio/views-generate`):

```
start_view_generation()  new GENERATING version per view (FINALIZING/VIEW_REVIEW -> GENERATING_VIEWS)
→ instructions already stored?  no → Claude sees the master image + the design record and writes
     design_summary · invariants · front_prompt · back_prompt · left_prompt · right_prompt
     → save_view_prompts()  stored once on the final design (write-once, canonical)
→ one `3d-studio/view-image-generate` execution per view, in parallel:
     start_view_image() → the image model edits the MASTER image with that view's instruction
     → stored as an asset (kind VIEW) → complete_view_image()   or fail_view_image()
→ finish_view_generation()  all four READY → VIEW_REVIEW; otherwise the failed ones wait for a retry
```

- **View model (Pollinations):** views use `POLLINATIONS_VIEW_MODEL` (default `openai/gpt-image-1-mini`).
  FLUX edit models keep the reference's camera angle, so all four views came out as the master angle; gpt-image
  moves the camera while keeping the object.
- **Same object, only the viewpoint changes:** every view is generated from the master image (never from
  another view, never from an earlier attempt) with Claude's per-view instruction, which restates the
  invariants and fixes camera height, distance, background and lighting.
- **Independent views:** if LEFT fails, FRONT/BACK/RIGHT are kept; "Retry left" (or "Retry failed views")
  creates a new LEFT version only. While generating, ready views can't be redone.
- **Regenerate this view** (in VIEW_REVIEW): a new version of exactly that view from the master design and its
  stored instruction; earlier versions stay in `final_views` as non-current history.
- **Approve all views:** `approve_all_views()` approves the four current views and moves the project to
  UPLOADING_TO_DRIVE. Google Drive delivery is the next step and isn't connected yet.
- **Recovery:** a claimed view job that died is failed after 11 minutes; views whose instructions never
  arrived after 31 minutes; when nothing is running and all four are ready, the project moves to review.

Mock scenarios: `AI_IMAGE_MOCK_SCENARIO=fail:<n>` fails view *n* on its first version (FRONT=1, BACK=2,
LEFT=3, RIGHT=4) and a retry succeeds; `AI_MOCK_SCENARIO=views_malformed_then_ok` / `views_down` exercise the
Claude step.

## 24. Google Drive delivery

**Approve all views** moves the project to UPLOADING_TO_DRIVE and starts `[3D Studio] M1 · Drive — export`
(`3d-studio/drive-export`). It builds:

```
3D PROJECTS/
  <ID8> - <Project name>/
    01_CONCEPTS/         C01 - <title>.png …
    02_REVISIONS/        C01 - Revision 01.png …
    03_APPROVED_DESIGN/  MASTER.png  FRONT.png  BACK.png  LEFT.png  RIGHT.png
    04_METADATA/         project.json
```

Images are delivered as PNG (the app converts JPEG/WebP losslessly). `project.json` holds the project, client,
brief, approved concept and revision, and the Drive file of the master image and each view. It contains no
secrets.

**How it stays idempotent:**
- `start_drive_export()` claims a run. A second webhook while one runs gets `409 export_in_progress`; after
  completion it gets `200 already_completed`. A run that stopped reporting for 20 minutes is replaced.
- Every Drive folder/file is a row in `drive_items` (`project_id` + `item_key`, never its name), saved after
  every Drive call. On the next run a stored ID is verified and reused. Each item also carries an
  `appProperties` tag in Drive, so an item whose ID never reached the database (crash right after creating it)
  is found again instead of duplicated. Only then is anything created.
- File content is uploaded separately (`PATCH …?uploadType=media`). An image whose stored upload matches its
  source asset is never uploaded again; `project.json` is rewritten in place each run.
- Failures are per item: if LEFT fails, the rest is kept, the run ends FAILED, the project stays in
  UPLOADING_TO_DRIVE, and **Retry upload** uploads only what's missing. When everything is there,
  `complete_drive_export()` stores the Drive IDs on the views, records `DRIVE_UPLOAD_COMPLETED`, moves the
  project to **COMPLETED** and records `PROJECT_COMPLETED`.

**Connecting Google Drive (live):**
1. In Google Cloud, enable the Google Drive API and create an OAuth client of type *Web application* with the
   redirect URI `<n8n URL>/rest/oauth2-credential/callback` (locally `http://localhost:5680/rest/oauth2-credential/callback`).
2. Put `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` in `.env` and run `pnpm n8n:credentials`
   (or enter them directly in the n8n credential **"3D Studio — Google Drive"**).
3. Open that credential in n8n and click **Connect my account** (Google consent screen).
4. Set `DRIVE_MODE=live` (and optionally `DRIVE_PARENT_FOLDER_ID`) and recreate the web container.

The browser never sees Google credentials: they exist only in n8n.

**Developing without Google (test double):** `COMPOSE_PROFILES=n8n,drive-test` starts `fake-drive` (port 4010),
a small Drive v3 stand-in (`infra/fake-drive/server.mjs`). With `DRIVE_MODE=test` uploads go there. Use its admin
endpoints to inject failures, e.g.
`curl -X POST localhost:4010/__admin/fail -d '{"op":"upload","match":"LEFT.png","status":503,"times":99}'`
(`op`: get, search, create or upload); `/__admin/clear-failures`, `/__admin/state`, `/__admin/reset`.
The completion screen only links to real Google Drive folders.

## 25. Security

- **Access gate:** set `STUDIO_ACCESS_PASSWORD` (and the generated `STUDIO_SESSION_SECRET`) to require sign-in for
  every page, API route and Server Action (`apps/web/src/proxy.ts`). The session is a 30-day HMAC-signed HttpOnly
  cookie (`SameSite=Lax`, `Secure` behind HTTPS). Five wrong passwords per client in 10 minutes are refused.
  Exempt: `/login`, `/api/health`, and `/api/internal/*` (bearer token). There are no per-user accounts in
  Milestone 1.
- **Headers:** CSP (`default-src 'self'`, no third-party origins, `frame-ancestors 'none'`), `X-Frame-Options`,
  `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP (`next.config.ts`). Set HSTS at the reverse proxy.
- **Secrets:** API keys and OAuth tokens live only in n8n credentials (encrypted with `N8N_ENCRYPTION_KEY`, so back
  it up). The web app holds only the two shared tokens and the DB URL. Nothing secret uses a `NEXT_PUBLIC_` prefix.
- **Limits:** JSON API bodies 64 KB, Server Actions 1 MB, images 20 MB (PNG/JPEG/WebP by magic bytes), brief
  4,000 characters, refinement 1,000, concepts 2–5 per request.
- **Production checklist:** TLS reverse proxy; only `web` published; block `/api/internal/*` at the proxy;
  n8n editor behind VPN/IP allow-list; n8n webhooks reachable only from `web`; `DRIVE_MODE=live`;
  `COMPOSE_PROFILES=n8n` (never `drive-test`); a strong `STUDIO_ACCESS_PASSWORD`; back up `pg_data`,
  `n8n_data`, `assets_data` and `.env`.
