import "server-only";
import { z } from "zod";
import { callWebhook, type N8nConfig } from "./client";
import { N8nContractError } from "./errors";

/** n8n workflow "[3D Studio] M1 · Concepts — generate" (n8n/workflows/m1-concepts-generate.json). */
export const CONCEPTS_GENERATE_WEBHOOK = "3d-studio/concepts-generate";

export type ConceptGenerationConfig = {
  provider_mode: "live" | "mock";
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  mock_scenario?: string;
  /** Nano Banana model for the concept images (each concept gets its own n8n image job). */
  image_model: string;
  /** "gemini" (Nano Banana, default) or "pollinations" (for testing the flow without a Gemini key). */
  image_provider?: "gemini" | "pollinations";
  /** Pollinations model id, e.g. "black-forest-labs/flux.2-klein-4b" (n8n's default when omitted). */
  pollinations_model?: string;
  /** Pollinations model for the four views; must be able to move the camera ("openai/gpt-image-1-mini" by default). */
  pollinations_view_model?: string;
  image_mock_scenario?: string;
};

/** Non-secret generation settings from the web app's environment (sent with each request). */
export function conceptConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ConceptGenerationConfig {
  const effort = env.CLAUDE_EFFORT as ConceptGenerationConfig["effort"] | undefined;
  const mock = env.AI_PROVIDER_MODE === "mock";
  return {
    provider_mode: mock ? "mock" : "live",
    model: env.CLAUDE_MODEL || "claude-sonnet-5-5",
    effort: effort && ["low", "medium", "high", "xhigh", "max"].includes(effort) ? effort : "high",
    ...(mock && env.AI_MOCK_SCENARIO ? { mock_scenario: env.AI_MOCK_SCENARIO } : {}),
    image_model: env.IMAGE_MODEL || "gemini-3.1-flash-image",
    ...(env.IMAGE_PROVIDER === "pollinations" ? { image_provider: "pollinations" as const } : {}),
    ...(env.IMAGE_PROVIDER === "pollinations" && env.POLLINATIONS_MODEL ? { pollinations_model: env.POLLINATIONS_MODEL } : {}),
    ...(env.IMAGE_PROVIDER === "pollinations" && env.POLLINATIONS_VIEW_MODEL ? { pollinations_view_model: env.POLLINATIONS_VIEW_MODEL } : {}),
    ...(mock && env.AI_IMAGE_MOCK_SCENARIO ? { image_mock_scenario: env.AI_IMAGE_MOCK_SCENARIO } : {}),
  };
}

const acceptedSchema = z.object({
  project_id: z.uuid(),
  status: z.literal("GENERATING_CONCEPTS"),
  accepted: z.literal(true),
  concept_count: z.number().int().min(2).max(5),
});

/**
 * Asks n8n to generate concepts. n8n moves the project to GENERATING_CONCEPTS and answers
 * 202 at once; Claude runs afterwards and the result lands in the database (the workspace
 * polls for it). Rejections (409 invalid_state, 422) surface as N8nRejectedError.
 */
export async function generateConceptsViaN8n(
  input: { projectId: string; conceptCount: number },
  options: { config?: N8nConfig; generation?: ConceptGenerationConfig; timeoutMs?: number } = {},
): Promise<{ projectId: string; conceptCount: number }> {
  const { body } = await callWebhook<unknown>(
    CONCEPTS_GENERATE_WEBHOOK,
    {
      project_id: input.projectId,
      concept_count: input.conceptCount,
      config: options.generation ?? conceptConfigFromEnv(),
    },
    { config: options.config, timeoutMs: options.timeoutMs ?? 15_000 },
  );
  const parsed = acceptedSchema.safeParse(body);
  if (!parsed.success) throw new N8nContractError("n8n concepts-generate returned an unexpected response");
  return { projectId: parsed.data.project_id, conceptCount: parsed.data.concept_count };
}
