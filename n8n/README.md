# n8n workflows

This folder is the source of truth for the project's n8n workflows. Don't edit them only in the n8n UI: changes made there are lost on the next deploy unless they're copied back into these files.

| File | Workflow | Webhook |
|---|---|---|
| `workflows/m1-project-create.json` | `[3D Studio] M1 · Project — create` | `POST /webhook/3d-studio/project-create` |
| `workflows/m1-concepts-generate.json` | `[3D Studio] M1 · Concepts — generate` | `POST /webhook/3d-studio/concepts-generate` |

Shared logic lives in `lib/`. Code nodes contain `/* @include lib/<file> */` markers, which the deploy script replaces with the file's contents. The same file is imported by the unit tests (`apps/web/tests/n8n/`), so the logic n8n runs is the logic that is tested.

## Rules (architecture §6.6–6.7)

- **Names and paths:** workflow names start with `[3D Studio]`, webhook paths with `3d-studio/`, and every deployed workflow is tagged `3d-automation`.
- **Credentials:** they're referenced **by name** in the JSON. IDs and secrets never live in git, and the deploy script resolves names to IDs on the target instance.
- **Authentication:** every webhook uses Header Auth (`X-Webhook-Token`). Only the web app's server calls them, never the browser.

## Credentials (created from `.env`)

| Name | Type | From |
|---|---|---|
| `3D Studio — App DB` | Postgres | `APP_DB_NAME`, `APP_DB_USER`, `APP_DB_PASSWORD`, `N8N_APP_DB_HOST` (default `postgres`) |
| `3D Studio — Inbound webhook token` | Header Auth | `N8N_WEBHOOK_TOKEN` (header `X-Webhook-Token`) |
| `3D Studio — Anthropic` | Anthropic | Enter the key **in the n8n UI**, or set `ANTHROPIC_API_KEY` in `.env`; it's synced only when set. If no key is given, a placeholder is created once and never overwrites a real key. Restricted to `api.anthropic.com`. |

## Deploy

The commands need `N8N_DEPLOY_URL_<ENV>` and `N8N_DEPLOY_API_KEY_<ENV>` in `.env`. Create the API key in n8n under Settings → n8n API.

Create or update the credentials:

```bash
pnpm n8n:credentials
```

Create or update the workflows, tag them, and publish them:

```bash
pnpm n8n:deploy
```

List what's deployed:

```bash
pnpm n8n:status
```

Use `--env production` to target another instance and `--dry-run` to preview. Before every deploy, the script saves a backup of every workflow on the instance to `n8n/backups/` (git-ignored).

The script never deletes anything. It refuses to:
- modify a workflow that isn't tagged `3d-automation`;
- deploy a webhook path that another workflow already uses.
