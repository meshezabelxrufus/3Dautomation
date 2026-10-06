import "server-only";
import { z } from "zod";
import { callWebhook, type N8nConfig } from "./client";
import { conceptConfigFromEnv, type ConceptGenerationConfig } from "./concepts";
import { N8nContractError } from "./errors";

/** n8n workflow "[3D Studio] M1 · Concept image — generate" (n8n/workflows/m1-concept-image-generate.json). */
export const CONCEPT_IMAGE_WEBHOOK = "3d-studio/concept-image-generate";
/** n8n workflow "[3D Studio] M1 · Concept — refine" (n8n/workflows/m1-concept-refine.json). */
export const CONCEPT_REFINE_WEBHOOK = "3d-studio/concept-refine";

type Options = { config?: N8nConfig; generation?: ConceptGenerationConfig; timeoutMs?: number };

const imageAccepted = z.object({ concept_id: z.uuid(), status: z.literal("GENERATING"), accepted: z.literal(true) });
const refineAccepted = z.object({ revision_id: z.uuid(), status: z.literal("GENERATING"), accepted: z.literal(true) });

/**
 * Re-runs Nano Banana for one concept whose image failed. n8n claims the job in the database
 * (FAILED -> GENERATING) and answers 202; the image lands later. 409 = already running / done.
 */
export async function retryConceptImageViaN8n(conceptId: string, options: Options = {}): Promise<void> {
  const g = options.generation ?? conceptConfigFromEnv();
  const { body } = await callWebhook<unknown>(
    CONCEPT_IMAGE_WEBHOOK,
    {
      concept_id: conceptId,
      retry: true,
      config: {
        provider_mode: g.provider_mode,
        image_model: g.image_model,
        image_mock_scenario: g.image_mock_scenario,
        image_provider: g.image_provider,
        pollinations_model: g.pollinations_model,
      },
    },
    { config: options.config, timeoutMs: options.timeoutMs ?? 15_000 },
  );
  if (!imageAccepted.safeParse(body).success) throw new N8nContractError("n8n concept-image-generate returned an unexpected response");
}

export type RefinementJob = { projectId: string; conceptId: string; revisionId: string };

/**
 * Runs a refinement whose revision row already exists (status GENERATING): Claude interprets
 * the feedback against the current version, the image model edits it, n8n settles the revision.
 * n8n re-checks that revision, concept and project belong together.
 */
export async function startRefinementViaN8n(job: RefinementJob, options: Options = {}): Promise<void> {
  const { body } = await callWebhook<unknown>(
    CONCEPT_REFINE_WEBHOOK,
    {
      project_id: job.projectId,
      concept_id: job.conceptId,
      revision_id: job.revisionId,
      config: options.generation ?? conceptConfigFromEnv(),
    },
    { config: options.config, timeoutMs: options.timeoutMs ?? 15_000 },
  );
  if (!refineAccepted.safeParse(body).success) throw new N8nContractError("n8n concept-refine returned an unexpected response");
}
