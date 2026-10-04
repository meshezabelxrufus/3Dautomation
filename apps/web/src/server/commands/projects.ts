/**
 * Commands invoked by Server Actions and the POST API. Each wraps workflow
 * operations. Dispatching the corresponding n8n job is added here in a later
 * step; for now the database state change is the whole effect.
 */
import type { Database } from "@/db/client";
import type { Project } from "@/db/schema";
import type { ViewType } from "@/server/domain/workflow-states";
import type { CreateProjectInput } from "@/lib/validation/project";
import * as wf from "@/server/workflow/workflow";

/** "GENERATE IDEAS": create the project and move it straight into concept generation. */
export async function createProjectAndGenerate(db: Database, input: CreateProjectInput): Promise<Project> {
  const project = await wf.createProject(db, {
    projectName: input.projectName,
    clientName: input.clientName,
    designBrief: input.designBrief,
  });
  // TODO(n8n step): dispatch WF-01 concepts.generate after this transition.
  return wf.startConceptGeneration(db, project.id, { requestedCount: input.ideaCount });
}

/** Start (or restart) idea generation for a DRAFT project or from concept review ("generate more"). */
export async function generateIdeas(db: Database, projectId: string, ideaCount: number): Promise<Project> {
  // TODO(n8n step): dispatch WF-01 concepts.generate.
  return wf.startConceptGeneration(db, projectId, { requestedCount: ideaCount });
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
