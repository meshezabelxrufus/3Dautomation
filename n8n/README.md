# n8n workflows

This folder is the source of truth for the project's n8n workflows. Don't edit them only in the n8n UI: changes made there are lost on the next deploy unless they're copied back into these files.

| File | Workflow | Webhook |
|---|---|---|
| `workflows/m1-project-create.json` | `[3D Studio] M1 · Project — create` | `POST /webhook/3d-studio/project-create` |
| `workflows/m1-concepts-generate.json` | `[3D Studio] M1 · Concepts — generate` | `POST /webhook/3d-studio/concepts-generate` |
| `workflows/m1-concept-image-generate.json` | `[3D Studio] M1 · Concept image — generate` | `POST /webhook/3d-studio/concept-image-generate` |
| `workflows/m1-concept-refine.json` | `[3D Studio] M1 · Concept — refine` | `POST /webhook/3d-studio/concept-refine` |
| `workflows/m1-views-generate.json` | `[3D Studio] M1 · Views — generate` | `POST /webhook/3d-studio/views-generate` |
| `workflows/m1-view-image-generate.json` | `[3D Studio] M1 · View image — generate` | `POST /webhook/3d-studio/view-image-generate` |
| `workflows/m1-drive-export.json` | `[3D Studio] M1 · Drive — export` | `POST /webhook/3d-studio/drive-export` |

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
| `3D Studio — Gemini` | Google Gemini (PaLM) API | Same rule, with `GEMINI_API_KEY`. Used for Nano Banana. Restricted to `generativelanguage.googleapis.com`. |
| `3D Studio — Pollinations` | Header Auth | Image API for testing without Gemini (`IMAGE_PROVIDER=pollinations`): `Authorization: Bearer POLLINATIONS_API_KEY`. Synced only when set; otherwise a placeholder is created once. |
| `3D Studio — Google Drive` | Google Drive OAuth2 | `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (synced only when set; otherwise a placeholder is created once). Then **Connect my account** in the n8n UI. Restricted to `www.googleapis.com`. |
| `3D Studio — App callback token` | Header Auth | `N8N_CALLBACK_TOKEN` (header `Authorization: Bearer …`). n8n uses it to upload and read images through the app's `/api/internal/assets`. |

## Deploy-time settings

Workflows contain two placeholders that `pnpm n8n:deploy` fills from `.env`:

| Placeholder | Variable | Default |
|---|---|---|
| `__3DS_APP_BASE_URL__` | `N8N_APP_BASE_URL`: the app as n8n reaches it | `http://web:3000` |
| `__3DS_N8N_SELF_URL__` | `N8N_SELF_URL`: n8n as it reaches itself (fan-out to child workflows) | `http://127.0.0.1:5678` |
| `__3DS_FAKE_DRIVE_URL__` | `N8N_FAKE_DRIVE_URL`: the local Drive test double (only used when `drive_mode` is `test`) | `http://fake-drive:4010` |

They're deploy-time on purpose: webhook callers can't point n8n (and the callback token) at another host.
On a VPS, set them to that stack's internal URLs before deploying.

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
