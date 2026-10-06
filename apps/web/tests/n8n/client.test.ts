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
      { config: config(), generation: { provider_mode: "live", model: "claude-sonnet-5-5", effort: "high", image_model: "gemini-3.1-flash-image" } },
    );
    expect(r).toEqual({ projectId: ok.project_id, conceptCount: 4 });
    expect(last.url).toBe(`/webhook/${CONCEPTS_GENERATE_WEBHOOK}`);
    expect(last.body).toEqual({
      project_id: ok.project_id,
      concept_count: 4,
      config: { provider_mode: "live", model: "claude-sonnet-5-5", effort: "high", image_model: "gemini-3.1-flash-image" },
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
    expect(conceptConfigFromEnv({} as NodeJS.ProcessEnv)).toEqual({
      provider_mode: "live",
      model: "claude-sonnet-5-5",
      effort: "high",
      image_model: "gemini-3.1-flash-image",
    });
    expect(conceptConfigFromEnv({ AI_IMAGE_MOCK_SCENARIO: "fail:2" } as unknown as NodeJS.ProcessEnv)).not.toHaveProperty("image_mock_scenario");
    expect(conceptConfigFromEnv({ AI_PROVIDER_MODE: "live", AI_MOCK_SCENARIO: "refusal" } as unknown as NodeJS.ProcessEnv)).not.toHaveProperty("mock_scenario");
    expect(
      conceptConfigFromEnv({ AI_PROVIDER_MODE: "mock", AI_MOCK_SCENARIO: "refusal", CLAUDE_EFFORT: "max" } as unknown as NodeJS.ProcessEnv),
    ).toMatchObject({ provider_mode: "mock", mock_scenario: "refusal", effort: "max" });
  });
});

describe("n8n image and refine clients", () => {
  const gen = { provider_mode: "mock" as const, model: "claude-sonnet-5-5", effort: "high" as const, image_model: "gemini-3.1-flash-image", image_mock_scenario: "fail:2" };
  const conceptId = "0b0e7a52-6d4c-4c39-9a53-1d7c1b1f0a01";

  it("retries one concept image with retry: true and only image settings", async () => {
    const { retryConceptImageViaN8n, CONCEPT_IMAGE_WEBHOOK } = await import("@/server/n8n/images");
    reply = { status: 202, body: { concept_id: conceptId, status: "GENERATING", accepted: true } };
    await retryConceptImageViaN8n(conceptId, { config: config(), generation: gen });
    expect(last.url).toBe(`/webhook/${CONCEPT_IMAGE_WEBHOOK}`);
    expect(last.body).toEqual({
      concept_id: conceptId,
      retry: true,
      config: { provider_mode: "mock", image_model: "gemini-3.1-flash-image", image_mock_scenario: "fail:2" },
    });
  });

  it("maps 'already running' to a rejection with its code", async () => {
    const { retryConceptImageViaN8n } = await import("@/server/n8n/images");
    reply = { status: 409, body: { error: { code: "image_in_progress", message: "busy" } } };
    const err = await retryConceptImageViaN8n(conceptId, { config: config(), generation: gen }).catch((e) => e);
    expect(err).toBeInstanceOf(N8nRejectedError);
    expect(err.code).toBe("image_in_progress");
  });

  it("starts a refinement with project, concept and revision ids", async () => {
    const { startRefinementViaN8n, CONCEPT_REFINE_WEBHOOK } = await import("@/server/n8n/images");
    const job = { projectId: ok.project_id, conceptId, revisionId: "5d7c2f3e-9b8a-4c1d-8e2f-3a4b5c6d7e8f" };
    reply = { status: 202, body: { revision_id: job.revisionId, status: "GENERATING", accepted: true } };
    await startRefinementViaN8n(job, { config: config(), generation: gen });
    expect(last.url).toBe(`/webhook/${CONCEPT_REFINE_WEBHOOK}`);
    expect(last.body).toMatchObject({
      project_id: ok.project_id,
      concept_id: conceptId,
      revision_id: job.revisionId,
      config: { image_model: "gemini-3.1-flash-image" },
    });
    reply = { status: 202, body: { ok: true } };
    await expect(startRefinementViaN8n(job, { config: config(), generation: gen })).rejects.toBeInstanceOf(N8nContractError);
  });
});

describe("n8n views client", () => {
  const projectId = "8f096623-3889-44d5-9eb3-325ab1861850";
  const finalDesignId = "1b6f0f0e-5f4c-4d8e-9a3b-2c1d0e9f8a7b";

  it("starts views for the final design, all or exactly the requested ones", async () => {
    const { generateViewsViaN8n, VIEWS_GENERATE_WEBHOOK } = await import("@/server/n8n/views");
    reply = { status: 202, body: { project_id: projectId, final_design_id: finalDesignId, view_types: ["BACK"], status: "GENERATING_VIEWS", accepted: true } };
    const r = await generateViewsViaN8n({ projectId, finalDesignId, viewTypes: ["BACK"] }, { config: config() });
    expect(r.viewTypes).toEqual(["BACK"]);
    expect(last.url).toBe(`/webhook/${VIEWS_GENERATE_WEBHOOK}`);
    expect(last.body).toMatchObject({ project_id: projectId, final_design_id: finalDesignId, view_types: ["BACK"] });
    await generateViewsViaN8n({ projectId, finalDesignId }, { config: config() });
    expect(last.body).toMatchObject({ view_types: [] });
  });

  it("surfaces 'already running' as a rejection with its code", async () => {
    const { generateViewsViaN8n } = await import("@/server/n8n/views");
    reply = { status: 409, body: { error: { code: "views_in_progress", message: "busy" } } };
    await expect(generateViewsViaN8n({ projectId, finalDesignId }, { config: config() })).rejects.toMatchObject({ code: "views_in_progress" });
    reply = { status: 202, body: { accepted: true } };
    await expect(generateViewsViaN8n({ projectId, finalDesignId }, { config: config() })).rejects.toBeInstanceOf(N8nContractError);
  });
});
