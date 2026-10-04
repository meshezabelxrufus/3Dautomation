import { InvalidStateTransitionError, type WorkflowEntity } from "@/server/domain/workflow-states";

export { InvalidStateTransitionError };

/** A cross-entity rule failed (e.g. uploading before all 4 views are approved). */
export class WorkflowGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowGuardError";
  }
}

export class NotFoundError extends Error {
  constructor(
    readonly entity: WorkflowEntity,
    readonly id: string,
  ) {
    super(`${entity} ${id} not found`);
    this.name = "NotFoundError";
  }
}

type PgLikeError = { code?: string; constraint?: string; message?: string; detail?: string };

function pgErrorOf(err: unknown): PgLikeError | undefined {
  // drizzle-orm wraps driver errors in DrizzleQueryError with the pg error as `cause`.
  const candidate = (err as { cause?: unknown })?.cause ?? err;
  if (candidate && typeof candidate === "object" && "code" in candidate) {
    return candidate as PgLikeError;
  }
  return undefined;
}

/**
 * Converts database-raised workflow violations (triggers in migration 0001) into
 * typed errors. Anything else is returned unchanged.
 */
export function toWorkflowError(err: unknown): unknown {
  const pg = pgErrorOf(err);
  if (pg?.code !== "23514") return err;

  if (pg.constraint === "workflow_status_transition") {
    const detail = safeJson(pg.detail);
    const match = /invalid_state_transition: (\S+) (\S+) -> (\S+)/.exec(pg.message ?? "");
    const entity = (detail?.entity ?? match?.[1] ?? "project") as WorkflowEntity;
    const from = detail?.from ?? match?.[2] ?? "?";
    const to = detail?.to ?? match?.[3] ?? "?";
    return new InvalidStateTransitionError(entity, from, to);
  }
  if (pg.constraint === "workflow_guard") {
    return new WorkflowGuardError(pg.message ?? "workflow guard failed");
  }
  return err;
}

function safeJson(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Record<string, string>;
  } catch {
    return undefined;
  }
}
