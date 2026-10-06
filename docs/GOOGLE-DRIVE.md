# Google Drive delivery

When the client approves all four views, n8n (`[3D Studio] M1 · Drive — export`) delivers the design
package to Google Drive and the project becomes **COMPLETED**.

```
3D PROJECTS/
  <ID8> - <Project name>/                 e.g. "05CCEFF6 - Mechanical Wolf Bust"
    01_CONCEPTS/         C01 - <title>.png …          every concept image (including rejected ones)
    02_REVISIONS/        C01 - Revision 01.png …      every finished revision
    03_APPROVED_DESIGN/  MASTER.png FRONT.png BACK.png LEFT.png RIGHT.png
    04_METADATA/         project.json
```

- **Names are display only.** Characters Drive or file systems dislike (`/ \ : * ? " < > |`, control
  characters) are replaced, and names are capped at 80 characters. Nothing is ever looked up by name.
- **PNG files.** The app converts JPEG/WebP images losslessly (`/api/internal/assets/:id?format=png`).
- **`project.json`** holds the schema version, project id/name, client, brief, approved concept and revision
  (with the change summary), design summary and invariants, `master_image` / `front` / `back` / `left` /
  `right` (file name, Drive file ID, Drive URL, asset ID), the Drive folder, `created_at`, `finalized_at` and
  `completed_at`. It contains no credentials, tokens or internal URLs.

## Idempotency

| Mechanism | Protects against |
|---|---|
| `drive_exports` run lock (`start_drive_export`) | Duplicate webhooks / double clicks: a second call while one runs gets `409 export_in_progress`; after completion `200 already_completed` |
| `drive_items` row per folder/file (`project_id` + `item_key`, e.g. `file:LEFT`) with `drive_file_id`, `drive_url`, saved after **every** Drive call | Re-runs reuse stored IDs (verified first) instead of creating new items |
| `appProperties.studio_item = "<project id>:<item key>"` on every Drive item | A crash after Drive created an item but before its ID was saved: the next run finds it by tag |
| Content uploaded separately (`PATCH …/upload/drive/v3/files/<id>?uploadType=media`) and recorded with the uploaded asset ID | A re-run never uploads an image twice; it overwrites the same file if needed |
| Item deleted/trashed in Drive since the last run | Detected on verify; recreated once |
| Run that stopped reporting (n8n restart) | Treated as dead after 20 minutes (n8n timeout is 19), so a new run can start |

**Partial failure:** every item succeeds or fails on its own. If LEFT fails, the folders, MASTER, FRONT,
BACK, RIGHT and `project.json` are kept, the run ends FAILED with a client-safe reason, the project stays
in UPLOADING_TO_DRIVE, and **Retry upload** uploads only what's missing. Blocked items (inside a folder
that couldn't be created) are reported as such.

**Errors:** 408/425/429/5xx and Drive rate-limit 403s are retried (4 attempts with backoff); 401/other 403s
stop the run at once with "reconnect the Google Drive account"; other 4xx fail the item.

## Setting up Google Drive (live)

1. **Google Cloud project:** enable the *Google Drive API*.
2. **OAuth consent screen:** External (or Internal for Workspace). Add your Google account as a test user
   while the app is in testing.
3. **Credentials → Create OAuth client ID → Web application.** Authorized redirect URI:
   `<n8n URL>/rest/oauth2-credential/callback` (locally `http://localhost:5680/rest/oauth2-credential/callback`).
4. Put the client ID/secret in `.env` (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`) and run
   `pnpm n8n:credentials`, or paste them into the n8n credential **3D Studio — Google Drive**.
5. In n8n, open **3D Studio — Google Drive** and click **Connect my account**. Approve the consent screen.
6. Set `DRIVE_MODE=live` (optionally `DRIVE_PARENT_FOLDER_ID`, the folder that should contain
   `3D PROJECTS`; default My Drive root) and recreate the web container: `docker compose up -d web`.

Use an OAuth *user* credential. A service account has no storage quota in a personal My Drive. The
token lives only in n8n's encrypted credential store (`N8N_ENCRYPTION_KEY`); the browser never sees it. The
completion screen shows a link only for real `drive.google.com` folders.

> **Status:** the live Google path is implemented and deployed but has **not been run against a real Google
> account** (no OAuth client was available during development). Everything else (structure, idempotency,
> partial failure, retry, duplicate webhooks, API failures) was verified end to end through n8n against
> the Drive test double below. Do one supervised delivery after connecting the credential.

## Drive test double (development)

`infra/fake-drive/server.mjs` implements the Drive v3 calls the workflow uses (files.get / list by
appProperties / create, media upload), requires an `Authorization` header, and supports failure injection.
Start it with `COMPOSE_PROFILES=n8n,drive-test` and set `DRIVE_MODE=test`.

```bash
curl -X POST localhost:4010/__admin/fail -d '{"op":"upload","match":"LEFT.png","status":503,"times":99}'
curl -X POST localhost:4010/__admin/fail -d '{"op":"search","match":"","status":401,"times":1}'
curl -X POST localhost:4010/__admin/clear-failures
curl localhost:4010/__admin/state           # every file with parents, size, md5, tags
curl -X POST localhost:4010/__admin/reset   # wipe (state is in memory; a restart also wipes it)
```

`op` is `get`, `search`, `create` or `upload`; `match` is a substring of the file name (or tag for
`search`). Never enable the `drive-test` profile in production.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Google Drive rejected the studio's credentials…" | OAuth token missing/expired/revoked: reconnect **3D Studio — Google Drive** in n8n, then **Retry upload** |
| "Google Drive is temporarily unavailable…" | 5xx/429 after 4 attempts: **Retry upload** later; nothing already uploaded is repeated |
| Upload stuck on "Delivering…" | Open the project after 21 minutes; the stalled run is marked failed and **Retry upload** appears |
| Files land in My Drive root | Set `DRIVE_PARENT_FOLDER_ID` and recreate `web` |
| A file was deleted in Drive after completion | Completed projects aren't re-exported automatically; the stored IDs remain in `drive_items` |
