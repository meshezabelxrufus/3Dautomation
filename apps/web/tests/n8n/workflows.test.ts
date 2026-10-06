import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type Node = { name: string; type: string; parameters: Record<string, unknown>; credentials?: Record<string, { id?: string; name: string }>; webhookId?: string };
type Workflow = { name: string; nodes: Node[]; connections: Record<string, { main: { node: string }[][] }> };

const root = path.resolve(import.meta.dirname, "../../../..");
const dir = path.join(root, "n8n/workflows");
const { expandIncludes, expandPlaceholders, PLACEHOLDER_DEFAULTS } = await import(path.join(root, "scripts/n8n-lib.mjs"));
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

describe.each(files)("n8n workflow %s", (file) => {
  const raw: Workflow = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  const wf: Workflow = expandPlaceholders(expandIncludes(raw), PLACEHOLDER_DEFAULTS);

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
      // n8n runs Code nodes as an async function body with $input/$/$json in scope.
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      expect(() => new AsyncFunction("$input", "$", "$json", js), `${n.name}`).not.toThrow();
    }
  });

  it("calls external services only through named credentials, and the app only via deploy-time URLs", () => {
    for (const n of raw.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest")) {
      const url = String(n.parameters.url);
      if (url.startsWith("=__3DS_FAKE_DRIVE_URL__")) {
        // The local Drive test double: no credentials at all, and only reachable via the deploy-time URL.
        expect(n.parameters.authentication, n.name).toBe("none");
        continue;
      }
      if (url.startsWith("=https://www.googleapis.com")) {
        expect(n.credentials?.googleDriveOAuth2Api?.name, n.name).toBe("3D Studio — Google Drive");
        continue;
      }
      expect(n.parameters.authentication, n.name).toMatch(/^(predefinedCredentialType|genericCredentialType)$/);
      if (url.includes("request.url")) {
        // Provider URL built by n8n/lib/image-generation.cjs: Gemini or Pollinations.
        const cred = n.credentials?.googlePalmApi?.name ?? n.credentials?.httpHeaderAuth?.name;
        expect(["3D Studio — Gemini", "3D Studio — Pollinations"], n.name).toContain(cred);
      } else if (url.includes("api.anthropic.com")) {
        expect(n.credentials?.anthropicApi?.name, n.name).toBe("3D Studio — Anthropic");
      } else if (url.includes("/api/internal/")) {
        expect(url, n.name).toMatch(/^=?__3DS_APP_BASE_URL__\//);
        expect(n.credentials?.httpHeaderAuth?.name, n.name).toBe("3D Studio — App callback token");
      } else {
        expect(url, n.name).toMatch(/^__3DS_N8N_SELF_URL__\/webhook\/3d-studio\//);
        expect(n.credentials?.httpHeaderAuth?.name, n.name).toBe("3D Studio — Inbound webhook token");
      }
    }
  });

  it("no API key or token is written into the workflow", () => {
    const text = JSON.stringify(raw);
    expect(text).not.toMatch(/sk-ant-|AIza[0-9A-Za-z_-]{20}|Bearer [0-9a-f]{16}/);
  });
});

describe("deploy-time placeholders", () => {
  it("rejects values that are not plain origins", async () => {
    const { placeholderValues } = await import(path.join(root, "scripts/n8n-lib.mjs"));
    expect(() => placeholderValues({ N8N_APP_BASE_URL: "http://web:3000/x?y" })).toThrow();
    expect(placeholderValues({ N8N_APP_BASE_URL: "http://host.docker.internal:3101" }).__3DS_APP_BASE_URL__).toBe("http://host.docker.internal:3101");
  });

  it("fails on unknown placeholders", () => {
    expect(() => expandPlaceholders({ name: "x", nodes: [{ parameters: { url: "__3DS_NOPE__" } }] }, PLACEHOLDER_DEFAULTS)).toThrow(/unknown placeholder/);
  });
});
