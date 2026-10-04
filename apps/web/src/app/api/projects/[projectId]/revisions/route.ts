import { connection, type NextRequest } from "next/server";
import { getDb } from "@/lib/server/db";
import { notFound, ok, parseId } from "@/server/http/responses";
import { getProjectStatus, getRevisions } from "@/server/queries/projects";

/** GET /api/projects/:projectId/revisions: every revision of every concept. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/projects/[projectId]/revisions">) {
  await connection();
  const id = parseId((await ctx.params).projectId);
  if (!id || !(await getProjectStatus(getDb(), id))) return notFound();
  return ok({ revisions: await getRevisions(getDb(), id) });
}
