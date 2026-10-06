import "server-only";
import { z } from "zod";
import type { ViewType } from "@/server/domain/workflow-states";
import { callWebhook, type N8nConfig } from "./client";
import { conceptConfigFromEnv, type ConceptGenerationConfig } from "./concepts";
import { N8nContractError } from "./errors";

/** n8n workflow "[3D Studio] M1 · Views — generate" (n8n/workflows/m1-views-generate.json). */
export const VIEWS_GENERATE_WEBHOOK = "3d-studio/views-generate";

const accepted = z.object({
  project_id: z.uuid(),
  final_design_id: z.uuid(),
  view_types: z.array(z.enum(["FRONT", "BACK", "LEFT", "RIGHT"])),
  status: z.literal("GENERATING_VIEWS"),
  accepted: z.literal(true),
});

/**
 * Starts views of the finalized design. Without viewTypes: all four on the first run, or every failed
 * view on a retry. With viewTypes: exactly those ("regenerate this view"). n8n creates the new view
 * versions in the database and answers 202; images land later, each from the canonical master image.
 */
export async function generateViewsViaN8n(
  input: { projectId: string; finalDesignId: string; viewTypes?: ViewType[] },
  options: { config?: N8nConfig; generation?: ConceptGenerationConfig; timeoutMs?: number } = {},
): Promise<{ viewTypes: ViewType[] }> {
  const { body } = await callWebhook<unknown>(
    VIEWS_GENERATE_WEBHOOK,
    {
      project_id: input.projectId,
      final_design_id: input.finalDesignId,
      view_types: input.viewTypes ?? [],
      config: options.generation ?? conceptConfigFromEnv(),
    },
    { config: options.config, timeoutMs: options.timeoutMs ?? 15_000 },
  );
  const parsed = accepted.safeParse(body);
  if (!parsed.success) throw new N8nContractError("n8n views-generate returned an unexpected response");
  return { viewTypes: parsed.data.view_types };
}
