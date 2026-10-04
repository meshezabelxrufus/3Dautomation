/**
 * Workflow operations for Milestone 1. Each operation runs in one transaction:
 * lock the row(s), check the transition (typed error), write the change, append
 * the project event. Database triggers enforce the same rules independently, so
 * the database stays authoritative even for writes that bypass this module.
 *
 * No AI or Drive calls happen here. Later steps call these operations from the
 * BFF routes and the n8n callback handler.
 */
import { and, eq, inArray, max } from "drizzle-orm";
import type { Database, DbExecutor } from "@/db/client";
import {
  concepts,
  finalDesigns,
  finalViews,
  projects,
  revisions,
  type Concept,
  type FinalDesign,
  type FinalView,
  type Project,
  type Revision,
} from "@/db/schema";
import {
  assertTransition,
  VIEW_TYPES,
  type ConceptStatus,
  type ProjectStatus,
  type ViewType,
} from "@/server/domain/workflow-states";
import { NotFoundError, toWorkflowError, WorkflowGuardError } from "./errors";
import { recordEvent } from "./events";

type Tx = DbExecutor;

async function inTx<T>(db: Database, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(fn);
  } catch (err) {
    throw toWorkflowError(err);
  }
}

// ---------------------------------------------------------------------------
// Row locking + transition helpers
// ---------------------------------------------------------------------------

async function lockProject(tx: Tx, projectId: string): Promise<Project> {
  const [row] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
  if (!row) throw new NotFoundError("project", projectId);
  return row;
}

async function lockConcept(tx: Tx, conceptId: string): Promise<Concept> {
  const [row] = await tx.select().from(concepts).where(eq(concepts.id, conceptId)).for("update");
  if (!row) throw new NotFoundError("concept", conceptId);
  return row;
}

async function lockRevision(tx: Tx, revisionId: string): Promise<Revision> {
  const [row] = await tx.select().from(revisions).where(eq(revisions.id, revisionId)).for("update");
  if (!row) throw new NotFoundError("revision", revisionId);
  return row;
}

async function lockFinalDesign(tx: Tx, finalDesignId: string): Promise<FinalDesign> {
  const [row] = await tx.select().from(finalDesigns).where(eq(finalDesigns.id, finalDesignId)).for("update");
  if (!row) throw new NotFoundError("final_design", finalDesignId);
  return row;
}

async function lockView(tx: Tx, viewId: string): Promise<FinalView> {
  const [row] = await tx.select().from(finalViews).where(eq(finalViews.id, viewId)).for("update");
  if (!row) throw new NotFoundError("final_view", viewId);
  return row;
}

function requireProjectStatus(project: Project, allowed: readonly ProjectStatus[], action: string): void {
  if (!allowed.includes(project.status)) {
    throw new WorkflowGuardError(
      `${action} requires project status in {${allowed.join(",")}}, got ${project.status}`,
    );
  }
}

async function setProjectStatus(
  tx: Tx,
  project: Project,
  to: ProjectStatus,
  extra: Partial<Pick<Project, "failureReason">> = {},
): Promise<Project> {
  assertTransition("project", project.status, to);
  if (project.status === "FAILED" && to !== project.failedFromStatus) {
    throw new WorkflowGuardError(`retry must return to ${project.failedFromStatus}, not ${to}`);
  }
  const [row] = await tx
    .update(projects)
    .set({ status: to, ...extra })
    .where(eq(projects.id, project.id))
    .returning();
  return row!;
}

async function setConceptStatus(
  tx: Tx,
  concept: Concept,
  to: ConceptStatus,
  extra: Partial<Pick<Concept, "imageUrl" | "generationPrompt">> = {},
): Promise<Concept> {
  assertTransition("concept", concept.status, to);
  const [row] = await tx
    .update(concepts)
    .set({ status: to, ...extra })
    .where(eq(concepts.id, concept.id))
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export type CreateProjectInput = { projectName: string; clientName: string; designBrief: string };

export function createProject(db: Database, input: CreateProjectInput): Promise<Project> {
  return inTx(db, async (tx) => {
    const [project] = await tx.insert(projects).values(input).returning();
    await recordEvent(tx, project!.id, "PROJECT_CREATED", {
      projectName: input.projectName,
      clientName: input.clientName,
    });
    return project!;
  });
}

export function getProject(db: Database, projectId: string): Promise<Project | undefined> {
  return db.query.projects.findFirst({ where: eq(projects.id, projectId) });
}

export type FailProjectInput = { stage: string; reason: string; details?: Record<string, unknown> };

/** Moves the project to FAILED (from any failable status) and records GENERATION_FAILED. */
export function failProject(db: Database, projectId: string, input: FailProjectInput): Promise<Project> {
  return inTx(db, async (tx) => {
    const project = await lockProject(tx, projectId);
    const updated = await setProjectStatus(tx, project, "FAILED", { failureReason: input.reason });
    await recordEvent(tx, projectId, "GENERATION_FAILED", {
      stage: input.stage,
      reason: input.reason,
      failedFrom: project.status,
      ...input.details,
    });
    return updated;
  });
}

const RETRY_EVENT: Partial<Record<ProjectStatus, "CONCEPT_GENERATION_STARTED" | "VIEW_GENERATION_STARTED" | "DRIVE_UPLOAD_STARTED">> = {
  GENERATING_CONCEPTS: "CONCEPT_GENERATION_STARTED",
  GENERATING_VIEWS: "VIEW_GENERATION_STARTED",
  UPLOADING_TO_DRIVE: "DRIVE_UPLOAD_STARTED",
};

/** Retries a FAILED project by returning it to the status it failed from. */
export function retryProject(db: Database, projectId: string): Promise<Project> {
  return inTx(db, async (tx) => {
    const project = await lockProject(tx, projectId);
    if (project.status !== "FAILED" || !project.failedFromStatus) {
      throw new WorkflowGuardError(`retry requires a FAILED project, got ${project.status}`);
    }
    const target = project.failedFromStatus;
    const updated = await setProjectStatus(tx, project, target);
    const event = RETRY_EVENT[target];
    if (event) await recordEvent(tx, projectId, event, { retry: true });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Concept generation
// ---------------------------------------------------------------------------

export function startConceptGeneration(
  db: Database,
  projectId: string,
  input: { requestedCount: number },
): Promise<Project> {
  return inTx(db, async (tx) => {
    const project = await lockProject(tx, projectId);
    const updated = await setProjectStatus(tx, project, "GENERATING_CONCEPTS");
    await recordEvent(tx, projectId, "CONCEPT_GENERATION_STARTED", { requestedCount: input.requestedCount });
    return updated;
  });
}

export type AddConceptInput = {
  title: string;
  description: string;
  creativeDirection?: string;
  keyFeatures?: string[];
  materials?: string[];
  generationPrompt?: string;
  /** If provided, the concept is created READY; otherwise GENERATING. */
  imageUrl?: string;
};

export function addConcept(db: Database, projectId: string, input: AddConceptInput): Promise<Concept> {
  return inTx(db, async (tx) => {
    const project = await lockProject(tx, projectId); // serialises concept numbering
    requireProjectStatus(project, ["GENERATING_CONCEPTS"], "adding a concept");
    const [{ value: last } = { value: null }] = await tx
      .select({ value: max(concepts.conceptNumber) })
      .from(concepts)
      .where(eq(concepts.projectId, projectId));
    const [concept] = await tx
      .insert(concepts)
      .values({
        projectId,
        conceptNumber: (last ?? 0) + 1,
        title: input.title,
        description: input.description,
        creativeDirection: input.creativeDirection,
        keyFeatures: input.keyFeatures ?? [],
        materials: input.materials ?? [],
        generationPrompt: input.generationPrompt,
        imageUrl: input.imageUrl,
        status: input.imageUrl ? "READY" : "GENERATING",
      })
      .returning();
    return concept!;
  });
}

export function markConceptGenerated(
  db: Database,
  conceptId: string,
  input: { imageUrl: string; generationPrompt?: string },
): Promise<Concept> {
  return inTx(db, async (tx) => {
    const concept = await lockConcept(tx, conceptId);
    return setConceptStatus(tx, concept, "READY", {
      imageUrl: input.imageUrl,
      ...(input.generationPrompt ? { generationPrompt: input.generationPrompt } : {}),
    });
  });
}

export function markConceptFailed(db: Database, conceptId: string, reason: string): Promise<Concept> {
  return inTx(db, async (tx) => {
    const concept = await lockConcept(tx, conceptId);
    const updated = await setConceptStatus(tx, concept, "FAILED");
    await recordEvent(tx, concept.projectId, "GENERATION_FAILED", {
      stage: "CONCEPT",
      conceptId,
      reason,
    });
    return updated;
  });
}

export function completeConceptGeneration(db: Database, projectId: string): Promise<Project> {
  return inTx(db, async (tx) => {
    const project = await lockProject(tx, projectId);
    const rows = await tx
      .select({ status: concepts.status })
      .from(concepts)
      .where(eq(concepts.projectId, projectId));
    const updated = await setProjectStatus(tx, project, "CONCEPT_REVIEW");
    await recordEvent(tx, projectId, "CONCEPT_GENERATION_COMPLETED", {
      conceptCount: rows.length,
      failedCount: rows.filter((r) => r.status === "FAILED").length,
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Concept review
// ---------------------------------------------------------------------------

export function selectConcept(db: Database, conceptId: string): Promise<Concept> {
  return inTx(db, async (tx) => {
    const concept = await lockConcept(tx, conceptId);
    requireProjectStatus(await lockProject(tx, concept.projectId), ["CONCEPT_REVIEW"], "selecting a concept");
    const updated = await setConceptStatus(tx, concept, "SELECTED");
    await recordEvent(tx, concept.projectId, "CONCEPT_SELECTED", { conceptId });
    return updated;
  });
}

export function rejectConcept(db: Database, conceptId: string, reason?: string): Promise<Concept> {
  return inTx(db, async (tx) => {
    const concept = await lockConcept(tx, conceptId);
    requireProjectStatus(await lockProject(tx, concept.projectId), ["CONCEPT_REVIEW"], "rejecting a concept");
    const updated = await setConceptStatus(tx, concept, "REJECTED");
    await recordEvent(tx, concept.projectId, "CONCEPT_REJECTED", { conceptId, reason: reason ?? null });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Refinement
// ---------------------------------------------------------------------------

export function startRefinement(
  db: Database,
  conceptId: string,
  input: { clientFeedback: string },
): Promise<Revision> {
  return inTx(db, async (tx) => {
    const concept = await lockConcept(tx, conceptId);
    const project = await lockProject(tx, concept.projectId);
    await setProjectStatus(tx, project, "REFINING");
    await setConceptStatus(tx, concept, "REFINING");
    const [{ value: last } = { value: null }] = await tx
      .select({ value: max(revisions.revisionNumber) })
      .from(revisions)
      .where(eq(revisions.conceptId, conceptId));
    const [revision] = await tx
      .insert(revisions)
      .values({ conceptId, revisionNumber: (last ?? 0) + 1, clientFeedback: input.clientFeedback })
      .returning();
    await recordEvent(tx, concept.projectId, "REFINEMENT_STARTED", {
      conceptId,
      revisionId: revision!.id,
      revisionNumber: revision!.revisionNumber,
    });
    return revision!;
  });
}

export type CompleteRevisionInput = {
  imageUrl: string;
  interpretedInstruction: Record<string, unknown>;
  generationPrompt: string;
};

export function completeRevision(db: Database, revisionId: string, input: CompleteRevisionInput): Promise<Revision> {
  return inTx(db, async (tx) => {
    const revision = await lockRevision(tx, revisionId);
    const concept = await lockConcept(tx, revision.conceptId);
    const project = await lockProject(tx, concept.projectId);
    assertTransition("revision", revision.status, "READY");
    const [updated] = await tx
      .update(revisions)
      .set({ status: "READY", ...input })
      .where(eq(revisions.id, revisionId))
      .returning();
    await setConceptStatus(tx, concept, "READY");
    await setProjectStatus(tx, project, "CONCEPT_REVIEW");
    await recordEvent(tx, project.id, "REVISION_CREATED", {
      conceptId: concept.id,
      revisionId,
      revisionNumber: revision.revisionNumber,
    });
    return updated!;
  });
}

/** A failed refinement is not fatal: the concept and project return to review. */
export function failRevision(db: Database, revisionId: string, reason: string): Promise<Revision> {
  return inTx(db, async (tx) => {
    const revision = await lockRevision(tx, revisionId);
    const concept = await lockConcept(tx, revision.conceptId);
    const project = await lockProject(tx, concept.projectId);
    assertTransition("revision", revision.status, "FAILED");
    const [updated] = await tx
      .update(revisions)
      .set({ status: "FAILED" })
      .where(eq(revisions.id, revisionId))
      .returning();
    await setConceptStatus(tx, concept, "READY");
    await setProjectStatus(tx, project, "CONCEPT_REVIEW");
    await recordEvent(tx, project.id, "GENERATION_FAILED", {
      stage: "REFINEMENT",
      conceptId: concept.id,
      revisionId,
      reason,
    });
    return updated!;
  });
}

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

/** Client picks one concept (optionally a specific revision of it). Project -> FINALIZING. */
export function beginFinalization(
  db: Database,
  projectId: string,
  input: { conceptId: string; revisionId?: string },
): Promise<FinalDesign> {
  return inTx(db, async (tx) => {
    const project = await lockProject(tx, projectId);
    const concept = await lockConcept(tx, input.conceptId);
    if (concept.projectId !== projectId) {
      throw new WorkflowGuardError("concept does not belong to this project");
    }
    let masterImage = concept.imageUrl;
    if (input.revisionId) {
      const revision = await lockRevision(tx, input.revisionId);
      if (revision.conceptId !== concept.id) {
        throw new WorkflowGuardError("revision does not belong to this concept");
      }
      masterImage = revision.imageUrl;
    }
    if (!masterImage) throw new WorkflowGuardError("the chosen concept/revision has no image");

    await setProjectStatus(tx, project, "FINALIZING");
    const [design] = await tx
      .insert(finalDesigns)
      .values({
        projectId,
        approvedConceptId: concept.id,
        approvedRevisionId: input.revisionId ?? null,
        masterImage,
      })
      .returning();
    return design!;
  });
}

export function confirmFinalization(db: Database, finalDesignId: string): Promise<FinalDesign> {
  return inTx(db, async (tx) => {
    const design = await lockFinalDesign(tx, finalDesignId);
    const concept = await lockConcept(tx, design.approvedConceptId);
    assertTransition("final_design", design.status, "FINALIZED");
    const [updated] = await tx
      .update(finalDesigns)
      .set({ status: "FINALIZED" })
      .where(eq(finalDesigns.id, finalDesignId))
      .returning();
    await setConceptStatus(tx, concept, "FINAL");
    if (design.approvedRevisionId) {
      const revision = await lockRevision(tx, design.approvedRevisionId);
      if (revision.status === "READY") {
        // Only one SELECTED revision per concept.
        await tx
          .update(revisions)
          .set({ status: "READY" })
          .where(and(eq(revisions.conceptId, concept.id), eq(revisions.status, "SELECTED")));
        await tx.update(revisions).set({ status: "SELECTED" }).where(eq(revisions.id, revision.id));
      }
    }
    await recordEvent(tx, design.projectId, "DESIGN_FINALIZED", {
      finalDesignId,
      conceptId: concept.id,
      revisionId: design.approvedRevisionId,
    });
    return updated!;
  });
}

export function cancelFinalization(db: Database, finalDesignId: string): Promise<FinalDesign> {
  return inTx(db, async (tx) => {
    const design = await lockFinalDesign(tx, finalDesignId);
    const project = await lockProject(tx, design.projectId);
    assertTransition("final_design", design.status, "CANCELLED");
    const [updated] = await tx
      .update(finalDesigns)
      .set({ status: "CANCELLED" })
      .where(eq(finalDesigns.id, finalDesignId))
      .returning();
    await setProjectStatus(tx, project, "CONCEPT_REVIEW");
    return updated!;
  });
}

// ---------------------------------------------------------------------------
// Four views
// ---------------------------------------------------------------------------

/**
 * Starts (or restarts) view generation. Creates a new GENERATING version for each
 * requested view type; earlier versions stay in history as non-current.
 */
export function startViewGeneration(
  db: Database,
  projectId: string,
  viewTypes: readonly ViewType[] = VIEW_TYPES,
): Promise<FinalView[]> {
  return inTx(db, async (tx) => {
    const project = await lockProject(tx, projectId);
    await setProjectStatus(tx, project, "GENERATING_VIEWS");
    const [design] = await tx
      .select()
      .from(finalDesigns)
      .where(and(eq(finalDesigns.projectId, projectId), eq(finalDesigns.status, "FINALIZED")));
    if (!design) throw new WorkflowGuardError("view generation requires a FINALIZED final design");

    const created: FinalView[] = [];
    for (const viewType of viewTypes) {
      const [{ value: last } = { value: null }] = await tx
        .select({ value: max(finalViews.versionNumber) })
        .from(finalViews)
        .where(and(eq(finalViews.projectId, projectId), eq(finalViews.viewType, viewType)));
      await tx
        .update(finalViews)
        .set({ isCurrent: false })
        .where(
          and(eq(finalViews.projectId, projectId), eq(finalViews.viewType, viewType), eq(finalViews.isCurrent, true)),
        );
      const [view] = await tx
        .insert(finalViews)
        .values({ projectId, finalDesignId: design.id, viewType, versionNumber: (last ?? 0) + 1 })
        .returning();
      created.push(view!);
    }
    await recordEvent(tx, projectId, "VIEW_GENERATION_STARTED", { viewTypes: [...viewTypes] });
    return created;
  });
}

export function recordViewGenerated(db: Database, viewId: string, input: { imageUrl: string }): Promise<FinalView> {
  return inTx(db, async (tx) => {
    const view = await lockView(tx, viewId);
    assertTransition("final_view", view.status, "READY");
    const [updated] = await tx
      .update(finalViews)
      .set({ status: "READY", imageUrl: input.imageUrl })
      .where(eq(finalViews.id, viewId))
      .returning();
    await recordEvent(tx, view.projectId, "VIEW_GENERATED", {
      viewId,
      viewType: view.viewType,
      versionNumber: view.versionNumber,
    });
    return updated!;
  });
}

export function markViewFailed(db: Database, viewId: string, reason: string): Promise<FinalView> {
  return inTx(db, async (tx) => {
    const view = await lockView(tx, viewId);
    assertTransition("final_view", view.status, "FAILED");
    const [updated] = await tx
      .update(finalViews)
      .set({ status: "FAILED" })
      .where(eq(finalViews.id, viewId))
      .returning();
    await recordEvent(tx, view.projectId, "GENERATION_FAILED", {
      stage: "VIEW",
      viewId,
      viewType: view.viewType,
      reason,
    });
    return updated!;
  });
}

export function completeViewGeneration(db: Database, projectId: string): Promise<Project> {
  return inTx(db, async (tx) => setProjectStatus(tx, await lockProject(tx, projectId), "VIEW_REVIEW"));
}

export function approveView(db: Database, viewId: string): Promise<FinalView> {
  return inTx(db, async (tx) => {
    const view = await lockView(tx, viewId);
    requireProjectStatus(await lockProject(tx, view.projectId), ["VIEW_REVIEW"], "approving a view");
    if (!view.isCurrent) throw new WorkflowGuardError("only the current version of a view can be approved");
    assertTransition("final_view", view.status, "APPROVED");
    const [updated] = await tx
      .update(finalViews)
      .set({ status: "APPROVED" })
      .where(eq(finalViews.id, viewId))
      .returning();
    await recordEvent(tx, view.projectId, "VIEW_APPROVED", { viewId, viewType: view.viewType });
    return updated!;
  });
}

// ---------------------------------------------------------------------------
// Google Drive upload
// ---------------------------------------------------------------------------

export function startDriveUpload(db: Database, projectId: string): Promise<Project> {
  return inTx(db, async (tx) => {
    const updated = await setProjectStatus(tx, await lockProject(tx, projectId), "UPLOADING_TO_DRIVE");
    await recordEvent(tx, projectId, "DRIVE_UPLOAD_STARTED");
    return updated;
  });
}

export function completeDriveUpload(
  db: Database,
  projectId: string,
  input: { driveFileIds: Record<ViewType, string>; driveFolderId?: string },
): Promise<Project> {
  return inTx(db, async (tx) => {
    const project = await lockProject(tx, projectId);
    requireProjectStatus(project, ["UPLOADING_TO_DRIVE"], "completing the Drive upload");
    for (const viewType of VIEW_TYPES) {
      await tx
        .update(finalViews)
        .set({ driveFileId: input.driveFileIds[viewType] })
        .where(
          and(
            eq(finalViews.projectId, projectId),
            eq(finalViews.viewType, viewType),
            eq(finalViews.isCurrent, true),
          ),
        );
    }
    await recordEvent(tx, projectId, "DRIVE_UPLOAD_COMPLETED", {
      driveFileIds: input.driveFileIds,
      driveFolderId: input.driveFolderId ?? null,
    });
    const updated = await setProjectStatus(tx, project, "COMPLETED");
    await recordEvent(tx, projectId, "PROJECT_COMPLETED");
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export function listCurrentViews(db: DbExecutor, projectId: string): Promise<FinalView[]> {
  return db
    .select()
    .from(finalViews)
    .where(and(eq(finalViews.projectId, projectId), eq(finalViews.isCurrent, true)));
}

export function listConcepts(db: DbExecutor, projectId: string): Promise<Concept[]> {
  return db.select().from(concepts).where(eq(concepts.projectId, projectId)).orderBy(concepts.conceptNumber);
}

export function listRevisions(db: DbExecutor, conceptIds: string[]): Promise<Revision[]> {
  if (conceptIds.length === 0) return Promise.resolve([]);
  return db.select().from(revisions).where(inArray(revisions.conceptId, conceptIds));
}
