import { connection, type NextRequest } from "next/server";
import { getDb } from "@/lib/server/db";
import { notFound, ok, parseId } from "@/server/http/responses";
import { getProject } from "@/server/queries/projects";

/** GET /api/projects/:projectId */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/projects/[projectId]">) {
  await connection();
  const id = parseId((await ctx.params).projectId);
  const project = id ? await getProject(getDb(), id) : null;
  return project ? ok({ project }) : notFound();
}
