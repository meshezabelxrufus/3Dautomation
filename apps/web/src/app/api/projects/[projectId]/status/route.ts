import { connection, type NextRequest } from "next/server";
import { getDb } from "@/lib/server/db";
import { notFound, ok, parseId, withApiErrors } from "@/server/http/responses";
import { reapStaleJobs } from "@/server/commands/projects";
import { getProjectStatus } from "@/server/queries/projects";

/** GET /api/projects/:projectId/status: lightweight payload for polling. */
export const GET = withApiErrors(async function GET(_req: NextRequest, ctx: RouteContext<"/api/projects/[projectId]/status">) {
  await connection();
  const id = parseId((await ctx.params).projectId);
  if (id) await reapStaleJobs(getDb(), id);
  const status = id ? await getProjectStatus(getDb(), id) : null;
  return status ? ok({ status }) : notFound();
});
