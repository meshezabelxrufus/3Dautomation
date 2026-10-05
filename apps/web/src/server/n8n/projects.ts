import "server-only";
import { z } from "zod";
import { PROJECT_STATUSES } from "@/server/domain/workflow-states";
import { callWebhook, type N8nConfig } from "./client";
import { N8nContractError, N8nRejectedError } from "./errors";

/** n8n workflow "[3D Studio] M1 · Project — create" (n8n/workflows/m1-project-create.json). */
export const PROJECT_CREATE_WEBHOOK = "3d-studio/project-create";

const createdSchema = z.object({
  project_id: z.uuid(),
  status: z.enum(PROJECT_STATUSES),
  created_at: z.string().min(1),
});

const FIELD_NAMES: Record<string, string> = {
  project_name: "projectName",
  client_name: "clientName",
  design_brief: "designBrief",
};

export type CreatedProject = { projectId: string; status: (typeof PROJECT_STATUSES)[number]; createdAt: string };

/** Creates the project (and its PROJECT_CREATED event) through n8n. */
export async function createProjectViaN8n(
  input: { projectName: string; clientName: string; designBrief: string },
  options: { config?: N8nConfig; timeoutMs?: number } = {},
): Promise<CreatedProject> {
  try {
    const { body } = await callWebhook<unknown>(
      PROJECT_CREATE_WEBHOOK,
      { project_name: input.projectName, client_name: input.clientName, design_brief: input.designBrief },
      options,
    );
    const parsed = createdSchema.safeParse(body);
    if (!parsed.success) throw new N8nContractError("n8n project-create returned an unexpected response");
    return { projectId: parsed.data.project_id, status: parsed.data.status, createdAt: parsed.data.created_at };
  } catch (err) {
    if (err instanceof N8nRejectedError && Object.keys(err.fields).length) {
      // Translate n8n's snake_case field names into the app's form field names.
      const fields = Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [FIELD_NAMES[k] ?? k, v]));
      throw new N8nRejectedError(err.message, err.status, err.code, fields);
    }
    throw err;
  }
}
