import type { NextRequest } from "next/server";
import { getDb } from "@/lib/server/db";
import { readAsset } from "@/server/assets/storage";
import { notFound, parseId, withApiErrors } from "@/server/http/responses";

/**
 * GET /api/assets/:id: serves a stored image. Assets are immutable and content-addressed,
 * so browsers may cache them forever. (Ownership checks arrive with user accounts.)
 */
export const GET = withApiErrors(async function GET(request: NextRequest, ctx: RouteContext<"/api/assets/[assetId]">) {
  const id = parseId((await ctx.params).assetId);
  const found = id ? await readAsset(getDb(), id) : null;
  if (!found) return notFound("Asset");
  const etag = `"${found.asset.sha256}"`;
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return new Response(new Uint8Array(found.data), {
    headers: {
      "Content-Type": found.asset.mimeType,
      "Content-Length": String(found.data.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    },
  });
});
