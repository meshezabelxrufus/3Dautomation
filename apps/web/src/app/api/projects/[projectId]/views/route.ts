import { connection, type NextRequest } from "next/server";
import { getDb } from "@/lib/server/db";
import { notFound, ok, parseId } from "@/server/http/responses";
import { getProjectStatus, getFinalViews } from "@/server/queries/projects";

/** GET /api/projects/:projectId/views: the live final design and current four views. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/projects/[projectId]/views">) {
  await connection();
  const id = parseId((await ctx.params).projectId);
  if (!id || !(await getProjectStatus(getDb(), id))) return notFound();
  return ok({ finalViews: await getFinalViews(getDb(), id) });
}
