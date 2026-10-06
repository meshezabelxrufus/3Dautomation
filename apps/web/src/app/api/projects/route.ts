import { connection, type NextRequest } from "next/server";
import { getDb } from "@/lib/server/db";
import { createProjectSchema, fieldErrors } from "@/lib/validation/project";
import { createProjectAndGenerate } from "@/server/commands/projects";
import { N8nContractError, N8nRejectedError, N8nUnavailableError } from "@/server/n8n/errors";
import { apiError, ok, readJsonBody, workflowErrorResponse, withApiErrors } from "@/server/http/responses";
import { getProject, listProjects } from "@/server/queries/projects";

/** GET /api/projects: all projects, most recently updated first. */
export const GET = withApiErrors(async function GET() {
  await connection();
  return ok({ projects: await listProjects(getDb()) });
});

/** POST /api/projects: create a project and start concept generation ("Generate ideas"). */
export const POST = withApiErrors(async function POST(request: NextRequest) {
  const body = await readJsonBody(request, 64 * 1024);
  if (body instanceof Response) return body;
  const parsed = createProjectSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return Response.json(
      { error: { code: "validation_failed", message: "Invalid project", fields: fieldErrors(parsed.error) } },
      { status: 422 },
    );
  }
  try {
    const { projectId } = await createProjectAndGenerate(parsed.data);
    const dto = await getProject(getDb(), projectId);
    return dto ? ok({ project: dto }, 201) : apiError(500, "internal", "Project not readable after create");
  } catch (err) {
    if (err instanceof N8nRejectedError) {
      return Response.json({ error: { code: err.code, message: err.message, fields: err.fields } }, { status: 422 });
    }
    if (err instanceof N8nUnavailableError) return apiError(503, "automation_unavailable", "Automation service unavailable");
    if (err instanceof N8nContractError) return apiError(502, "automation_contract", "Unexpected automation response");
    return workflowErrorResponse(err);
  }
});
