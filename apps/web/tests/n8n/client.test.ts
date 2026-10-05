import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { N8nContractError, N8nRejectedError, N8nUnavailableError } from "@/server/n8n/errors";
import { createProjectViaN8n, PROJECT_CREATE_WEBHOOK } from "@/server/n8n/projects";

/** A fake n8n: each test sets how the next request is answered and inspects what was sent. */
type Reply = { status: number; body?: unknown; raw?: string; delayMs?: number };
let reply: Reply = { status: 201 };
let last: { url?: string; token?: string; body?: unknown } = {};
let server: Server;
let baseUrl: string;

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || "null");
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    last = { url: req.url, token: req.headers["x-webhook-token"] as string, body: await readBody(req) };
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const input = { projectName: "Wolf", clientName: "Acme", designBrief: "A mechanical wolf bust, geometric armor." };
const config = () => ({ baseUrl, token: "test-token" });
const ok = { project_id: "8f096623-3889-44d5-9eb3-325ab1861850", status: "DRAFT", created_at: "2026-10-04T14:42:21.435Z" };

describe("n8n project-create client", () => {
  it("posts snake_case fields with the shared secret and maps the response", async () => {
    reply = { status: 201, body: ok };
    const created = await createProjectViaN8n(input, { config: config() });
    expect(created).toEqual({ projectId: ok.project_id, status: "DRAFT", createdAt: ok.created_at });
    expect(last.url).toBe(`/webhook/${PROJECT_CREATE_WEBHOOK}`);
    expect(last.token).toBe("test-token");
    expect(last.body).toEqual({ project_name: "Wolf", client_name: "Acme", design_brief: input.designBrief });
  });

  it("maps n8n validation errors to the app's field names", async () => {
    reply = {
      status: 422,
      body: { error: { code: "validation_failed", message: "Invalid project", fields: { design_brief: "Too short.", client_name: "Required." } } },
    };
    const err = await createProjectViaN8n(input, { config: config() }).catch((e) => e);
    expect(err).toBeInstanceOf(N8nRejectedError);
    expect(err.fields).toEqual({ designBrief: "Too short.", clientName: "Required." });
  });

  it.each([
    [500, "server error"],
    [503, "database unavailable"],
    [403, "token mismatch"],
    [404, "workflow not published"],
  ])("treats %i (%s) as unavailable", async (status) => {
    reply = { status, body: { error: { code: "x", message: "x" } } };
    await expect(createProjectViaN8n(input, { config: config() })).rejects.toBeInstanceOf(N8nUnavailableError);
  });

  it("times out instead of hanging", async () => {
    reply = { status: 201, body: ok, delayMs: 500 };
    await expect(createProjectViaN8n(input, { config: config(), timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });

  it("reports an unreachable n8n as unavailable", async () => {
    await expect(
      createProjectViaN8n(input, { config: { baseUrl: "http://127.0.0.1:9", token: "t" }, timeoutMs: 2_000 }),
    ).rejects.toBeInstanceOf(N8nUnavailableError);
  });

  it("rejects responses that break the contract", async () => {
    reply = { status: 201, body: { project_id: "not-a-uuid", status: "DRAFT" } };
    await expect(createProjectViaN8n(input, { config: config() })).rejects.toBeInstanceOf(N8nContractError);
    reply = { status: 201, raw: "<html>oops</html>" };
    await expect(createProjectViaN8n(input, { config: config() })).rejects.toBeInstanceOf(N8nContractError);
  });

  it("refuses to run without configuration", async () => {
    const { n8nConfigFromEnv } = await import("@/server/n8n/client");
    expect(() => n8nConfigFromEnv({} as NodeJS.ProcessEnv)).toThrow(N8nUnavailableError);
  });
});

describe("n8n concepts-generate client", () => {
  it("sends project, count and non-secret generation config; accepts the 202", async () => {
    const { generateConceptsViaN8n, CONCEPTS_GENERATE_WEBHOOK } = await import("@/server/n8n/concepts");
    reply = { status: 202, body: { project_id: ok.project_id, status: "GENERATING_CONCEPTS", accepted: true, concept_count: 4 } };
    const r = await generateConceptsViaN8n(
      { projectId: ok.project_id, conceptCount: 4 },
      { config: config(), generation: { provider_mode: "live", model: "claude-sonnet-5-5", effort: "high" } },
    );
    expect(r).toEqual({ projectId: ok.project_id, conceptCount: 4 });
    expect(last.url).toBe(`/webhook/${CONCEPTS_GENERATE_WEBHOOK}`);
    expect(last.body).toEqual({
      project_id: ok.project_id,
      concept_count: 4,
      config: { provider_mode: "live", model: "claude-sonnet-5-5", effort: "high" },
    });
  });

  it("surfaces 'already generating' as a rejection, and odd answers as contract errors", async () => {
    const { generateConceptsViaN8n } = await import("@/server/n8n/concepts");
    reply = { status: 409, body: { error: { code: "invalid_state", message: "Concepts can't be generated", status: "GENERATING_CONCEPTS" } } };
    const err = await generateConceptsViaN8n({ projectId: ok.project_id, conceptCount: 3 }, { config: config() }).catch((e) => e);
    expect(err).toBeInstanceOf(N8nRejectedError);
    expect(err.code).toBe("invalid_state");
    reply = { status: 202, body: { accepted: true } };
    await expect(generateConceptsViaN8n({ projectId: ok.project_id, conceptCount: 3 }, { config: config() })).rejects.toBeInstanceOf(N8nContractError);
  });

  it("derives generation config from env; mock scenarios only in mock mode", async () => {
    const { conceptConfigFromEnv } = await import("@/server/n8n/concepts");
    expect(conceptConfigFromEnv({} as NodeJS.ProcessEnv)).toEqual({ provider_mode: "live", model: "claude-sonnet-5-5", effort: "high" });
    expect(conceptConfigFromEnv({ AI_PROVIDER_MODE: "live", AI_MOCK_SCENARIO: "refusal" } as unknown as NodeJS.ProcessEnv)).not.toHaveProperty("mock_scenario");
    expect(
      conceptConfigFromEnv({ AI_PROVIDER_MODE: "mock", AI_MOCK_SCENARIO: "refusal", CLAUDE_EFFORT: "max" } as unknown as NodeJS.ProcessEnv),
    ).toMatchObject({ provider_mode: "mock", mock_scenario: "refusal", effort: "max" });
  });
});
