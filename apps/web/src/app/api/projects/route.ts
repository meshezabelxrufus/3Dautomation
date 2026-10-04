import { connection, type NextRequest } from "next/server";
import { getDb } from "@/lib/server/db";
import { createProjectSchema, fieldErrors } from "@/lib/validation/project";
import { createProjectAndGenerate } from "@/server/commands/projects";
import { apiError, ok, workflowErrorResponse } from "@/server/http/responses";
import { getProject, listProjects } from "@/server/queries/projects";

/** GET /api/projects: all projects, most recently updated first. */
export async function GET() {
  await connection();
  return ok({ projects: await listProjects(getDb()) });
}

/** POST /api/projects: create a project and start concept generation ("Generate ideas"). */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = createProjectSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return Response.json(
      { error: { code: "validation_failed", message: "Invalid project", fields: fieldErrors(parsed.error) } },
      { status: 422 },
    );
  }
  try {
    const project = await createProjectAndGenerate(getDb(), parsed.data);
    const dto = await getProject(getDb(), project.id);
    return dto ? ok({ project: dto }, 201) : apiError(500, "internal", "Project not readable after create");
  } catch (err) {
    return workflowErrorResponse(err);
  }
}
