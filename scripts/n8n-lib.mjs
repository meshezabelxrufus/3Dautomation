/**
 * Helpers shared by scripts/n8n-deploy.mjs and the tests.
 *
 * Code nodes may contain `/* @include lib/<file> *\/` markers; they are replaced with the
 * file's contents (relative to n8n/) so tested modules run unchanged inside n8n.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const N8N_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../n8n");
const INCLUDE = /\/\* @include ([\w./-]+) \*\//g;

export function expandIncludes(workflow) {
  const nodes = workflow.nodes.map((node) => {
    const js = node.parameters?.jsCode;
    if (typeof js !== "string" || !js.includes("@include")) return node;
    const expanded = js.replace(INCLUDE, (_m, rel) => {
      const file = path.resolve(N8N_DIR, rel);
      if (!file.startsWith(N8N_DIR + path.sep)) throw new Error(`include outside n8n/: ${rel}`);
      return `// ---- begin ${rel} (inlined by scripts/n8n-deploy.mjs) ----\n${readFileSync(file, "utf8")}\n// ---- end ${rel} ----`;
    });
    return { ...node, parameters: { ...node.parameters, jsCode: expanded } };
  });
  return { ...workflow, nodes };
}

/**
 * Deploy-time settings baked into workflows. Kept out of webhook requests on purpose: a caller
 * must not be able to redirect n8n (and the callback token it sends) to another host.
 *   __3DS_APP_BASE_URL__  the app as n8n reaches it (asset uploads/downloads)
 *   __3DS_N8N_SELF_URL__  n8n as it reaches itself (fan-out to child workflows)
 *   __3DS_FAKE_DRIVE_URL__  the local Google Drive test double (only used when drive_mode = "test")
 */
export const PLACEHOLDER_DEFAULTS = {
  __3DS_APP_BASE_URL__: "http://web:3000",
  __3DS_N8N_SELF_URL__: "http://127.0.0.1:5678",
  __3DS_FAKE_DRIVE_URL__: "http://fake-drive:4010",
};

export function placeholderValues(env = process.env) {
  const values = {
    __3DS_APP_BASE_URL__: env.N8N_APP_BASE_URL || PLACEHOLDER_DEFAULTS.__3DS_APP_BASE_URL__,
    __3DS_N8N_SELF_URL__: env.N8N_SELF_URL || PLACEHOLDER_DEFAULTS.__3DS_N8N_SELF_URL__,
    __3DS_FAKE_DRIVE_URL__: env.N8N_FAKE_DRIVE_URL || PLACEHOLDER_DEFAULTS.__3DS_FAKE_DRIVE_URL__,
  };
  for (const [key, value] of Object.entries(values)) {
    if (!/^https?:\/\/[^\s/"'`{}]+$/.test(value)) throw new Error(`${key}: "${value}" must be an http(s) origin without a path`);
  }
  return values;
}

export function expandPlaceholders(workflow, values = placeholderValues()) {
  let text = JSON.stringify(workflow);
  for (const [key, value] of Object.entries(values)) text = text.split(key).join(value);
  const left = text.match(/__3DS_[A-Z_]+__/);
  if (left) throw new Error(`unknown placeholder ${left[0]} in "${workflow.name}"`);
  return JSON.parse(text);
}
