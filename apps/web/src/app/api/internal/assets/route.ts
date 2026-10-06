import type { NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/server/db";
import { ASSET_KINDS } from "@/server/domain/workflow-states";
import { AssetRejectedError, MAX_IMAGE_BYTES, storeImage } from "@/server/assets/storage";
import { apiError, ok, readJsonBody } from "@/server/http/responses";
import { withApiErrors } from "@/server/http/responses";
import { isAuthorizedCallback } from "@/server/http/internal-auth";

const bodySchema = z.object({
  project_id: z.uuid(),
  kind: z.enum(ASSET_KINDS),
  data_base64: z.string().min(16).max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4),
  provider: z.string().max(100).nullish(),
  model: z.string().max(200).nullish(),
  provider_request_id: z.string().max(500).nullish(),
  provider_url: z.string().max(2000).nullish(),
  prompt: z.string().max(8000).nullish(),
});

/** POST /api/internal/assets: n8n stores a generated image in app-controlled storage. */
export const POST = withApiErrors(async function POST(request: NextRequest) {
  if (!isAuthorizedCallback(request)) return apiError(401, "unauthorized", "Invalid callback token");
  // Base64 of the largest accepted image plus room for the other fields.
  const body = await readJsonBody(request, Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024);
  if (body instanceof Response) return body;
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return apiError(422, "validation_failed", parsed.error.issues[0]?.message ?? "Invalid body");
  const b = parsed.data;
  try {
    const asset = await storeImage(getDb(), {
      projectId: b.project_id,
      kind: b.kind,
      data: Buffer.from(b.data_base64, "base64"),
      provider: b.provider,
      model: b.model,
      providerRequestId: b.provider_request_id,
      providerUrl: b.provider_url,
      prompt: b.prompt,
    });
    return ok(
      { asset_id: asset.id, url: `/api/assets/${asset.id}`, mime_type: asset.mimeType, bytes: asset.bytes, width: asset.width, height: asset.height },
      201,
    );
  } catch (err) {
    if (err instanceof AssetRejectedError) return apiError(422, "invalid_image", err.message);
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "23503") return apiError(422, "project_not_found", "Project not found");
    throw err;
  }
});
