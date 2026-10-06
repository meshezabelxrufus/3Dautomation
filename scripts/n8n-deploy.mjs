#!/usr/bin/env node
/**
 * Deploys this project's n8n workflows (n8n/workflows/*.json) to an n8n instance through
 * its public API, following the separation rules in docs/MILESTONE-1-ARCHITECTURE.md §6.6–6.7.
 *
 *   node scripts/n8n-deploy.mjs credentials [--env local] [--dry-run]   create/update "3D Studio — …" credentials from .env
 *   node scripts/n8n-deploy.mjs deploy      [--env local] [--dry-run]   create/update + tag + publish "[3D Studio]" workflows
 *   node scripts/n8n-deploy.mjs status      [--env local]               list this project's workflows and credentials
 *
 * Guardrails: only touches workflows named "[3D Studio] …" (and tagged 3d-automation once
 * deployed) and credentials named "3D Studio — …"; refuses webhook-path collisions with any
 * other workflow; backs up every workflow on the instance before writing; never deletes.
 * Workflow files reference credentials by NAME; IDs are resolved on the target instance.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandIncludes, expandPlaceholders, placeholderValues } from "./n8n-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = path.join(ROOT, "n8n/workflows");
const BACKUP_DIR = path.join(ROOT, "n8n/backups");
const NAME_PREFIX = "[3D Studio]";
const CREDENTIAL_PREFIX = "3D Studio — ";
const WEBHOOK_PREFIX = "3d-studio/";
const TAG = "3d-automation";

// ---------------------------------------------------------------- args & env
const [command = "status", ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const option = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
};
const DRY_RUN = flag("dry-run");
const ENV = option("env", "local");

if (existsSync(path.join(ROOT, ".env"))) process.loadEnvFile(path.join(ROOT, ".env"));
const suffix = ENV.toUpperCase();
const BASE_URL = process.env[`N8N_DEPLOY_URL_${suffix}`];
const API_KEY = process.env[`N8N_DEPLOY_API_KEY_${suffix}`];
if (!BASE_URL || !API_KEY) {
  fail(`N8N_DEPLOY_URL_${suffix} and N8N_DEPLOY_API_KEY_${suffix} must be set in .env`);
}

function fail(message) {
  console.error(`n8n-deploy: ${message}`);
  process.exit(1);
}
const log = (message) => console.log(`${DRY_RUN ? "[dry-run] " : ""}${message}`);

// ---------------------------------------------------------------- API client
async function api(method, pathname, body) {
  const res = await fetch(new URL(`/api/v1${pathname}`, BASE_URL), {
    method,
    headers: { "X-N8N-API-KEY": API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status}: ${data?.message ?? text}`);
  return data;
}

async function listAll(pathname) {
  const items = [];
  let cursor;
  do {
    const sep = pathname.includes("?") ? "&" : "?";
    const page = await api("GET", `${pathname}${sep}limit=100${cursor ? `&cursor=${cursor}` : ""}`);
    items.push(...(page.data ?? []));
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

// ---------------------------------------------------------------- credentials
function desiredCredentials() {
  const need = (name) => process.env[name] ?? fail(`${name} is not set in .env`);
  return [
    {
      name: `${CREDENTIAL_PREFIX}App DB`,
      type: "postgres",
      data: {
        host: process.env.N8N_APP_DB_HOST ?? "postgres",
        port: Number(process.env.N8N_APP_DB_PORT ?? 5432),
        database: need("APP_DB_NAME"),
        user: need("APP_DB_USER"),
        password: need("APP_DB_PASSWORD"),
        ssl: "disable",
        sshTunnel: false,
        allowUnauthorizedCerts: false,
        maxConnections: 10,
      },
    },
    {
      name: `${CREDENTIAL_PREFIX}Inbound webhook token`,
      type: "httpHeaderAuth",
      data: { name: "X-Webhook-Token", value: need("N8N_WEBHOOK_TOKEN") },
    },
    {
      // The API key is normally entered in the n8n UI. It is only synced from .env when
      // ANTHROPIC_API_KEY is set; otherwise a placeholder is created once (never overwriting
      // a real key) so workflows can deploy and mock mode works.
      name: `${CREDENTIAL_PREFIX}Anthropic`,
      type: "anthropicApi",
      data: {
        apiKey: process.env.ANTHROPIC_API_KEY || "not-configured",
        header: false,
        allowedHttpRequestDomains: "domains",
        allowedDomains: "api.anthropic.com",
      },
      syncOnlyWhen: Boolean(process.env.ANTHROPIC_API_KEY),
    },
    {
      // Nano Banana (Gemini image models). Same rule as Anthropic: synced only when GEMINI_API_KEY
      // is set, otherwise a placeholder is created once.
      name: `${CREDENTIAL_PREFIX}Gemini`,
      type: "googlePalmApi",
      data: {
        host: "https://generativelanguage.googleapis.com",
        apiKey: process.env.GEMINI_API_KEY || "not-configured",
        allowedHttpRequestDomains: "domains",
        allowedDomains: "generativelanguage.googleapis.com",
      },
      syncOnlyWhen: Boolean(process.env.GEMINI_API_KEY),
    },
    {
      // Pollinations image API (IMAGE_PROVIDER=pollinations), key from https://enter.pollinations.ai/keys.
      // Same rule as the other API keys: synced only when set, otherwise a placeholder is created once.
      name: `${CREDENTIAL_PREFIX}Pollinations`,
      type: "httpHeaderAuth",
      data: { name: "Authorization", value: `Bearer ${process.env.POLLINATIONS_API_KEY || "not-configured"}` },
      syncOnlyWhen: Boolean(process.env.POLLINATIONS_API_KEY),
    },
    {
      // Google Drive (OAuth2). n8n needs a one-time "Connect my account" in its UI; the client ID/secret
      // come from a Google Cloud OAuth client (GOOGLE_OAUTH_CLIENT_ID/SECRET), synced only when set.
      name: `${CREDENTIAL_PREFIX}Google Drive`,
      type: "googleDriveOAuth2Api",
      data: {
        clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "not-configured",
        clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "not-configured",
        sendAdditionalBodyProperties: false,
        additionalBodyProperties: "",
        allowedHttpRequestDomains: "domains",
        allowedDomains: "www.googleapis.com",
      },
      syncOnlyWhen: Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET),
    },
    {
      // n8n -> app callbacks (asset upload/download). The app checks it in src/server/http/internal-auth.ts.
      name: `${CREDENTIAL_PREFIX}App callback token`,
      type: "httpHeaderAuth",
      data: { name: "Authorization", value: `Bearer ${need("N8N_CALLBACK_TOKEN")}` },
    },
  ];
}

async function ensureCredentials() {
  const existing = await listAll("/credentials");
  for (const cred of desiredCredentials()) {
    if (!cred.name.startsWith(CREDENTIAL_PREFIX)) fail(`refusing to manage credential "${cred.name}"`);
    const match = existing.find((c) => c.name === cred.name && c.type === cred.type);
    const { syncOnlyWhen, ...body } = cred;
    if (match) {
      if (syncOnlyWhen === false) {
        log(`credential "${cred.name}" exists (${match.id}): left unchanged (no value in .env)`);
        continue;
      }
      log(`credential "${cred.name}" exists (${match.id}): updating data from .env`);
      if (!DRY_RUN) await api("PATCH", `/credentials/${match.id}`, { name: body.name, type: body.type, data: body.data });
    } else {
      log(`credential "${cred.name}": creating${syncOnlyWhen === false ? " with a placeholder key (set it in the n8n UI)" : ""}`);
      if (!DRY_RUN) await api("POST", "/credentials", body);
    }
  }
}

// ---------------------------------------------------------------- workflows
function loadWorkflowFiles() {
  const values = placeholderValues();
  log(`app base URL for n8n: ${values.__3DS_APP_BASE_URL__}  n8n self URL: ${values.__3DS_N8N_SELF_URL__}`);
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ file, wf: expandPlaceholders(expandIncludes(JSON.parse(readFileSync(path.join(WORKFLOW_DIR, file), "utf8"))), values) }));
}

const webhookPaths = (wf) =>
  (wf.nodes ?? []).filter((n) => n.type === "n8n-nodes-base.webhook").map((n) => String(n.parameters?.path ?? ""));
const isOurs = (wf) => wf.name?.startsWith(NAME_PREFIX) && (wf.tags ?? []).some((t) => t.name === TAG);

function resolveCredentials(wf, credentials) {
  const missing = new Set();
  const nodes = wf.nodes.map((node) => {
    if (!node.credentials) return node;
    const resolved = {};
    for (const [type, ref] of Object.entries(node.credentials)) {
      const match = credentials.find((c) => c.name === ref.name && c.type === type);
      if (!match) missing.add(`${ref.name} (${type})`);
      else resolved[type] = { id: match.id, name: match.name };
    }
    return { ...node, credentials: resolved };
  });
  if (missing.size) fail(`missing credentials on ${ENV}: ${[...missing].join(", ")}. Run: node scripts/n8n-deploy.mjs credentials`);
  return nodes;
}

async function backup(remote) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `${ENV}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(remote, null, 2));
  log(`backup of ${remote.length} workflows -> ${path.relative(ROOT, file)}`);
}

async function ensureTag() {
  const tags = await listAll("/tags");
  const existing = tags.find((t) => t.name === TAG);
  if (existing) return existing;
  log(`tag "${TAG}": creating`);
  return DRY_RUN ? { id: "dry-run", name: TAG } : api("POST", "/tags", { name: TAG });
}

async function deploy() {
  const files = loadWorkflowFiles();
  if (files.length === 0) fail(`no workflow files in ${path.relative(ROOT, WORKFLOW_DIR)}`);

  const remote = await listAll("/workflows");
  const credentials = await listAll("/credentials");
  await backup(remote);

  for (const { file, wf } of files) {
    if (!wf.name?.startsWith(NAME_PREFIX)) fail(`${file}: workflow name must start with "${NAME_PREFIX}"`);
    for (const p of webhookPaths(wf)) {
      if (!p.startsWith(WEBHOOK_PREFIX)) fail(`${file}: webhook path "${p}" must start with "${WEBHOOK_PREFIX}"`);
      const clash = remote.find((r) => r.name !== wf.name && webhookPaths(r).includes(p));
      if (clash) fail(`${file}: webhook path "${p}" already used by "${clash.name}" (${clash.id})`);
    }
  }

  const tag = await ensureTag();
  for (const { file, wf } of files) {
    const body = {
      name: wf.name,
      nodes: resolveCredentials(wf, credentials),
      connections: wf.connections,
      settings: wf.settings ?? {},
    };
    const sameName = remote.filter((r) => r.name === wf.name);
    if (sameName.length > 1) fail(`${file}: ${sameName.length} workflows named "${wf.name}" on ${ENV}; resolve manually`);
    const existing = sameName[0];
    if (existing && !isOurs(existing)) {
      fail(`${file}: "${wf.name}" exists (${existing.id}) but is not tagged ${TAG}; refusing to modify it`);
    }

    let id = existing?.id;
    if (existing) {
      log(`${file}: updating "${wf.name}" (${id})`);
      if (!DRY_RUN) await api("PUT", `/workflows/${id}`, body);
    } else {
      log(`${file}: creating "${wf.name}"`);
      if (!DRY_RUN) id = (await api("POST", "/workflows", body)).id;
    }
    if (DRY_RUN) continue;
    await api("PUT", `/workflows/${id}/tags`, [{ id: tag.id }]);
    await api("POST", `/workflows/${id}/activate`, {});
    log(`${file}: tagged ${TAG} and published (${id})`);
  }
}

async function status() {
  const remote = (await listAll("/workflows")).filter((w) => w.name?.startsWith(NAME_PREFIX));
  const credentials = (await listAll("/credentials")).filter((c) => c.name.startsWith(CREDENTIAL_PREFIX));
  console.log(`n8n ${ENV} (${BASE_URL})`);
  for (const w of remote) {
    console.log(`  workflow ${w.id}  active=${w.active}  tagged=${isOurs(w)}  ${w.name}  webhooks=${webhookPaths(w).join(",")}`);
  }
  for (const c of credentials) console.log(`  credential ${c.id}  ${c.type}  ${c.name}`);
  if (!remote.length && !credentials.length) console.log("  (nothing deployed yet)");
}

const commands = { credentials: ensureCredentials, deploy, status };
if (!commands[command]) fail(`unknown command "${command}" (use: ${Object.keys(commands).join(", ")})`);
commands[command]().catch((err) => fail(err.message));
