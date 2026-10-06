import { InvalidStateTransitionError, NotFoundError, WorkflowGuardError } from "@/server/workflow/errors";
import { uuidSchema } from "@/lib/validation/project";
import type { ApiError } from "@/lib/api/types";

const NO_STORE = { "Cache-Control": "no-store" };

export function ok<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function apiError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } } satisfies ApiError, { status, headers: NO_STORE });
}

export const notFound = (what = "Project") => apiError(404, "not_found", `${what} not found`);

/** Returns the id if it is a valid UUID, else null (avoids Postgres cast errors). */
export function parseId(value: string): string | null {
  return uuidSchema.safeParse(value).success ? value : null;
}

/** Maps workflow errors to HTTP responses; rethrows anything unexpected. */
export function workflowErrorResponse(err: unknown): Response {
  if (err instanceof NotFoundError) return apiError(404, "not_found", err.message);
  if (err instanceof InvalidStateTransitionError) return apiError(409, "invalid_state_transition", err.message);
  if (err instanceof WorkflowGuardError) return apiError(409, "workflow_guard", err.message);
  throw err;
}

/**
 * Reads a JSON body with a size limit (checked on Content-Length and on the bytes actually read).
 * Returns null for malformed JSON; a Response (413) when the body is too large.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return apiError(413, "payload_too_large", `Request body larger than ${maxBytes} bytes`);
  const text = await request.text();
  if (Buffer.byteLength(text) > maxBytes) return apiError(413, "payload_too_large", `Request body larger than ${maxBytes} bytes`);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const DB_UNAVAILABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "ECONNRESET", "57P01", "57P03", "08000", "08001", "08003", "08006"]);

/** True when the error means "the database can't be reached right now" (not a bug in the query). */
export function isDatabaseUnavailable(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && DB_UNAVAILABLE_CODES.has(code)) return true;
    if (e instanceof Error && /Connection terminated|connect ECONNREFUSED|getaddrinfo/.test(e.message)) return true;
  }
  return false;
}

/**
 * Wraps a route handler: database outages become 503, workflow errors their mapped status, and
 * anything else a generic 500. Details go to the server log, never to the client.
 */
export function withApiErrors<A extends unknown[]>(handler: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      if (isDatabaseUnavailable(err)) {
        console.error("[api] database unavailable:", err instanceof Error ? err.message : err);
        return apiError(503, "database_unavailable", "The database is temporarily unavailable. Please try again shortly.");
      }
      try {
        return workflowErrorResponse(err);
      } catch {
        console.error("[api] unexpected error:", err);
        return apiError(500, "internal", "Something went wrong.");
      }
    }
  };
}
