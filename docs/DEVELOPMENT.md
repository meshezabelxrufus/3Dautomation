# Development Guide

How to install, configure, run and inspect the local stack for the 3D Design Studio (Milestone 1).
Architecture background: [`MILESTONE-1-ARCHITECTURE.md`](./MILESTONE-1-ARCHITECTURE.md).

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

---

## 1. Stack overview

| Service | Image | URL from your machine | Inside Docker network | Persistent volume |
|---|---|---|---|---|
| `web` | built from `apps/web/Dockerfile` (Next.js 16, standalone) | http://localhost:3100 | `http://web:3000` | `assets_data` → `/data/assets` |
| `n8n` | `n8nio/n8n:2.32.6` | http://localhost:5680 | `http://n8n:5678` | `n8n_data` → `/home/node/.n8n` |
| `postgres` | `postgres:16-alpine` | `localhost:5434` | `postgres:5432` | `pg_data` → `/var/lib/postgresql/data` |
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
   ```

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

