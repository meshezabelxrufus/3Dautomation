import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Node = { name: string; type: string; parameters: Record<string, unknown>; credentials?: Record<string, { id?: string; name: string }>; webhookId?: string };
type Workflow = { name: string; nodes: Node[]; connections: Record<string, { main: { node: string }[][] }> };

const root = path.resolve(import.meta.dirname, "../../../..");
const dir = path.join(root, "n8n/workflows");
const { expandIncludes } = await import(path.join(root, "scripts/n8n-lib.mjs"));
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

describe.each(files)("n8n workflow %s", (file) => {
  const raw: Workflow = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  const wf: Workflow = expandIncludes(raw);

  it("follows the project's separation conventions", () => {
    expect(wf.name.startsWith("[3D Studio]")).toBe(true);
    for (const n of wf.nodes.filter((n) => n.type === "n8n-nodes-base.webhook")) {
      expect(String(n.parameters.path)).toMatch(/^3d-studio\//);
      expect(n.parameters.authentication).toBe("headerAuth");
      expect(n.credentials?.httpHeaderAuth?.name).toBe("3D Studio — Inbound webhook token");
    }
    for (const n of wf.nodes) {
      for (const ref of Object.values(n.credentials ?? {})) {
        expect(ref.name.startsWith("3D Studio — ")).toBe(true);
        expect(ref.id).toBeUndefined(); // IDs are resolved per instance at deploy time
      }
    }
  });

  it("every connection points at an existing node", () => {
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const [from, conn] of Object.entries(wf.connections)) {
      expect(names.has(from)).toBe(true);
      for (const branch of conn.main) for (const t of branch) expect(names.has(t.node)).toBe(true);
    }
  });

  it("every Code node is valid JavaScript after includes are inlined", () => {
    for (const n of wf.nodes.filter((n) => n.type === "n8n-nodes-base.code")) {
      const js = String(n.parameters.jsCode);
      expect(js).not.toContain("@include");
      // n8n runs Code nodes as a function body with $input/$/$json in scope.
      expect(() => new Function("$input", "$", "$json", js), `${n.name}`).not.toThrow();
    }
  });
});
