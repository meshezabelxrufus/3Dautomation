import { connection, type NextRequest } from "next/server";
import { getDb } from "@/lib/server/db";
import { notFound, ok, parseId } from "@/server/http/responses";
import { getProjectStatus, getConcepts } from "@/server/queries/projects";

/** GET /api/projects/:projectId/concepts: concepts, by concept number. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/projects/[projectId]/concepts">) {
  await connection();
  const id = parseId((await ctx.params).projectId);
  if (!id || !(await getProjectStatus(getDb(), id))) return notFound();
  return ok({ concepts: await getConcepts(getDb(), id) });
}
