import "server-only";
import sharp from "sharp";

/** Lossless PNG of a stored image (PNG input is returned unchanged). */
export async function toPng(data: Buffer, mimeType: string): Promise<Buffer> {
  if (mimeType === "image/png") return data;
  return sharp(data).png({ compressionLevel: 9 }).toBuffer();
}
