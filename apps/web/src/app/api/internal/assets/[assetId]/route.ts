import type { NextRequest } from "next/server";
import { getDb } from "@/lib/server/db";
import { readAsset } from "@/server/assets/storage";
import { toPng } from "@/server/assets/convert";
import { notFound, ok, parseId, apiError, withApiErrors } from "@/server/http/responses";
import { isAuthorizedCallback } from "@/server/http/internal-auth";

/**
 * GET /api/internal/assets/:id: n8n reads a stored image (refinement input, view reference, Drive upload).
 * `?format=png` returns a lossless PNG of it (the Drive package uses .png files).
 */
export const GET = withApiErrors(async function GET(request: NextRequest, ctx: RouteContext<"/api/internal/assets/[assetId]">) {
  if (!isAuthorizedCallback(request)) return apiError(401, "unauthorized", "Invalid callback token");
  const id = parseId((await ctx.params).assetId);
  const found = id ? await readAsset(getDb(), id) : null;
  if (!found) return notFound("Asset");
  if (request.nextUrl.searchParams.get("format") === "png") {
    const png = await toPng(found.data, found.asset.mimeType);
    return ok({ asset_id: found.asset.id, mime_type: "image/png", sha256: found.asset.sha256, data_base64: png.toString("base64") });
  }
  return ok({ asset_id: found.asset.id, mime_type: found.asset.mimeType, sha256: found.asset.sha256, data_base64: found.data.toString("base64") });
});
