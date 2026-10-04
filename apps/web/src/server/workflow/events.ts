import { asc, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db/client";
import { projectEvents, type ProjectEvent } from "@/db/schema";
import type { ProjectEventType } from "@/server/domain/workflow-states";

export type EventPayload = Record<string, unknown>;

/** Appends an event. Call inside the same transaction as the state change it describes. */
export async function recordEvent(
  db: DbExecutor,
  projectId: string,
  eventType: ProjectEventType,
  payload: EventPayload = {},
): Promise<ProjectEvent> {
  const [event] = await db.insert(projectEvents).values({ projectId, eventType, payload }).returning();
  return event!;
}

export async function listEvents(db: DbExecutor, projectId: string): Promise<ProjectEvent[]> {
  return db
    .select()
    .from(projectEvents)
    .where(eq(projectEvents.projectId, projectId))
    .orderBy(asc(projectEvents.id));
}
