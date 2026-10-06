import "server-only";
import { timingSafeEqual } from "node:crypto";

/** Checks `Authorization: Bearer <N8N_CALLBACK_TOKEN>` for n8n -> app calls (constant-time). */
export function isAuthorizedCallback(request: Request, token = process.env.N8N_CALLBACK_TOKEN): boolean {
  if (!token) return false;
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
