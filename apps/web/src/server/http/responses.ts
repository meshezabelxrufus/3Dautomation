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
