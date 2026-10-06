import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Database } from "@/db/client";
import { assets, type Asset } from "@/db/schema";
import type { AssetKind } from "@/server/domain/workflow-states";
import { inspectImage } from "./images";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Application-controlled image storage (Docker volume in containers, ./.data/assets in dev). */
export function assetRoot(env: NodeJS.ProcessEnv = process.env): string {
  // Runtime data directory, not a source path: keep Turbopack's file tracing out of it.
  return path.resolve(/*turbopackIgnore: true*/ env.ASSET_STORAGE_DIR || path.join(process.cwd(), ".data/assets"));
}

export class AssetRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetRejectedError";
  }
}

export type StoreImageInput = {
  projectId: string;
  kind: AssetKind;
  data: Buffer;
  provider?: string | null;
  model?: string | null;
  providerRequestId?: string | null;
  providerUrl?: string | null;
  prompt?: string | null;
};

/**
 * Validates and stores an image. Files are content-addressed (<project>/<sha256>.<ext>) and
 * written atomically, so retries never produce half-written or duplicate files.
 */
export async function storeImage(db: Database, input: StoreImageInput, root = assetRoot()): Promise<Asset> {
  if (input.data.length === 0) throw new AssetRejectedError("empty image");
  if (input.data.length > MAX_IMAGE_BYTES) throw new AssetRejectedError(`image larger than ${MAX_IMAGE_BYTES} bytes`);
  const info = inspectImage(input.data);
  if (!info) throw new AssetRejectedError("not a PNG, JPEG or WebP image");

  const sha256 = createHash("sha256").update(input.data).digest("hex");
  const storageKey = `${input.projectId}/${sha256}.${info.ext}`;
  const file = path.join(root, storageKey);
  const exists = await stat(file).then(() => true, () => false);
  if (!exists) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, input.data, { mode: 0o640 });
    await rename(tmp, file);
  }

  const [row] = await db
    .insert(assets)
    .values({
      projectId: input.projectId,
      kind: input.kind,
      storageKey,
      mimeType: info.mimeType,
      bytes: input.data.length,
      width: info.width,
      height: info.height,
      sha256,
      provider: input.provider ?? null,
      model: input.model ?? null,
      providerRequestId: input.providerRequestId ?? null,
      providerUrl: input.providerUrl ?? null,
      prompt: input.prompt ?? null,
    })
    .returning();
  return row!;
}

export async function readAsset(db: Database, assetId: string, root = assetRoot()): Promise<{ asset: Asset; data: Buffer } | null> {
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset) return null;
  const file = path.resolve(root, asset.storageKey);
  if (!file.startsWith(root + path.sep)) return null;
  const data = await readFile(file).catch(() => null);
  return data ? { asset, data } : null;
}
