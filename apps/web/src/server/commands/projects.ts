/**
 * Commands invoked by Server Actions and the POST API. Steps that are already n8n
 * workflows go through src/server/n8n; the rest are database transitions that will
 * dispatch their n8n jobs in later steps.
 */
import type { Database } from "@/db/client";
import type { ViewType } from "@/server/domain/workflow-states";
import type { CreateProjectInput } from "@/lib/validation/project";
import { and, eq, lt, sql } from "drizzle-orm";
import { projects } from "@/db/schema";
import { generateConceptsViaN8n } from "@/server/n8n/concepts";
import { createProjectViaN8n } from "@/server/n8n/projects";
import * as wf from "@/server/workflow/workflow";

/**
 * "GENERATE IDEAS": n8n creates the project (+ PROJECT_CREATED), then n8n starts concept
 * generation with Claude. Creation is the part that must succeed; if starting generation
 * fails (n8n busy, network), the project stays in DRAFT and its workspace offers
 * "Generate ideas" again. Returns whether generation started.
 */
export async function createProjectAndGenerate(
  input: CreateProjectInput,
  deps: { createProject?: typeof createProjectViaN8n; generateConcepts?: typeof generateConceptsViaN8n } = {},
): Promise<{ projectId: string; generationStarted: boolean }> {
  const created = await (deps.createProject ?? createProjectViaN8n)({
    projectName: input.projectName,
    clientName: input.clientName,
    designBrief: input.designBrief,
  });
  try {
    await (deps.generateConcepts ?? generateConceptsViaN8n)({ projectId: created.projectId, conceptCount: input.ideaCount });
    return { projectId: created.projectId, generationStarted: true };
  } catch (err) {
    console.error("[n8n] project created but concept generation did not start:", err instanceof Error ? err.message : err);
    return { projectId: created.projectId, generationStarted: false };
  }
}

/** Start concept generation from DRAFT, "more ideas" from CONCEPT_REVIEW, or a retry after a failure. */
export async function generateIdeas(projectId: string, ideaCount: number, deps: { generateConcepts?: typeof generateConceptsViaN8n } = {}) {
  return (deps.generateConcepts ?? generateConceptsViaN8n)({ projectId, conceptCount: ideaCount });
}

/** Longest a generation may run before the app gives up on it (n8n's own limit is 15 min). */
export const CONCEPT_GENERATION_DEADLINE_MS = 16 * 60_000;

/**
 * If n8n died mid-generation (restart, crash) nobody would ever finish the job. This marks
 * such a project FAILED so the client can retry. Called lazily when the project is read.
 */
export async function reapStaleConceptGeneration(db: Database, projectId: string, now = new Date()): Promise<boolean> {
  const cutoff = new Date(now.getTime() - CONCEPT_GENERATION_DEADLINE_MS);
  const [stale] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.status, "GENERATING_CONCEPTS"), lt(projects.updatedAt, cutoff)));
  if (!stale) return false;
  const result = await db.execute<{ outcome: string }>(
    sql`select outcome from fail_concept_generation(${projectId}::uuid, ${"Generating concepts took too long and was stopped. Please try again."}, ${JSON.stringify({ code: "timeout" })}::jsonb)`,
  );
  return result.rows[0]?.outcome === "failed";
}

/** Refinement request on a concept. */
export async function refineConcept(db: Database, conceptId: string, clientFeedback: string) {
  // TODO(n8n step): dispatch WF-02 concept.refine with the new revision id.
  return wf.startRefinement(db, conceptId, { clientFeedback });
}

/**
 * Client approves one concept (optionally a specific revision) as the final design:
 * FINALIZING -> final design FINALIZED -> GENERATING_VIEWS.
 */
export async function finalizeDesign(db: Database, projectId: string, conceptId: string, revisionId?: string) {
  const pending = await wf.beginFinalization(db, projectId, { conceptId, revisionId });
  await wf.confirmFinalization(db, pending.id);
  // TODO(n8n step): dispatch WF-03 views.generate.
  return wf.startViewGeneration(db, projectId);
}

/** Approve every remaining READY view and start the Drive delivery. */
export async function approveViewsAndDeliver(db: Database, projectId: string) {
  for (const view of await wf.listCurrentViews(db, projectId)) {
    if (view.status === "READY") await wf.approveView(db, view.id);
  }
  // TODO(n8n step): dispatch WF-04 drive.export.
  return wf.startDriveUpload(db, projectId);
}

export async function regenerateView(db: Database, projectId: string, viewType: ViewType) {
  // TODO(n8n step): dispatch WF-03 views.generate for this view only.
  return wf.startViewGeneration(db, projectId, [viewType]);
}
