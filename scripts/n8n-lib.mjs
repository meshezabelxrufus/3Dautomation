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
