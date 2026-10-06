/**
 * Commands invoked by Server Actions and the POST API. Steps that are already n8n
 * workflows go through src/server/n8n; the rest are database transitions that will
 * dispatch their n8n jobs in later steps.
 */
import type { Database } from "@/db/client";
import type { ViewType } from "@/server/domain/workflow-states";
import type { CreateProjectInput } from "@/lib/validation/project";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { concepts, projects, revisions } from "@/db/schema";
import { generateConceptsViaN8n } from "@/server/n8n/concepts";
import { retryConceptImageViaN8n, startRefinementViaN8n, type RefinementJob } from "@/server/n8n/images";
import { createProjectViaN8n } from "@/server/n8n/projects";
import { N8nRejectedError } from "@/server/n8n/errors";
import { NotFoundError } from "@/server/workflow/errors";
import { generateViewsViaN8n } from "@/server/n8n/views";
import { startDriveExportViaN8n } from "@/server/n8n/drive";

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

/**
 * Longest a generation (Claude + every concept image) may run before the app gives up on it.
 * n8n's own limit for the concepts workflow is 25 min.
 */
export const CONCEPT_GENERATION_DEADLINE_MS = 26 * 60_000;
/** Same for one image job or one refinement (n8n limit: 10 min each). */
export const IMAGE_JOB_DEADLINE_MS = 11 * 60_000;

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

/**
 * Image jobs (a concept image retried in review, a refinement) whose n8n execution died are
 * failed after IMAGE_JOB_DEADLINE_MS so the client can retry. Called lazily on read.
 */
export async function reapStaleImageJobs(db: Database, projectId: string, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - IMAGE_JOB_DEADLINE_MS);
  let reaped = 0;
  const stuckImages = await db
    .select({ id: concepts.id })
    .from(concepts)
    .innerJoin(projects, eq(projects.id, concepts.projectId))
    .where(
      and(
        eq(concepts.projectId, projectId),
        eq(concepts.status, "GENERATING"),
        isNotNull(concepts.imageRequestedAt),
        lt(concepts.imageRequestedAt, cutoff),
        // While the batch is still running, its own workflow (or the project reaper) closes it.
        inArray(projects.status, ["CONCEPT_REVIEW", "REFINING"]),
      ),
    );
  for (const c of stuckImages) {
    await db.execute(
      sql`select outcome from fail_concept_image(${c.id}::uuid, ${"Image generation did not finish. You can retry it."}, ${JSON.stringify({ code: "image_timeout" })}::jsonb)`,
    );
    reaped++;
  }
  const stuckRevisions = await db
    .select({ id: revisions.id })
    .from(revisions)
    .innerJoin(concepts, eq(concepts.id, revisions.conceptId))
    .where(and(eq(concepts.projectId, projectId), eq(revisions.status, "GENERATING"), lt(revisions.createdAt, cutoff)));
  for (const r of stuckRevisions) {
    await db.execute(
      sql`select outcome from fail_refinement(${r.id}::uuid, ${"The refinement did not finish. Please try again."}, ${JSON.stringify({ code: "timeout" })}::jsonb)`,
    );
    reaped++;
  }
  return reaped;
}

/** Every lazy recovery check for one project (run before reading it). */
export async function reapStaleJobs(db: Database, projectId: string, now = new Date()): Promise<void> {
  await reapStaleConceptGeneration(db, projectId, now);
  await reapStaleImageJobs(db, projectId, now);
  await reapStaleViewJobs(db, projectId, now);
  await reapStaleDriveExports(db, projectId, now);
}

/** Every concept action names its project; a concept from another project is treated as not found. */
export async function assertConceptInProject(db: Database, projectId: string, conceptId: string): Promise<void> {
  const [row] = await db.select({ projectId: concepts.projectId }).from(concepts).where(eq(concepts.id, conceptId));
  if (!row || row.projectId !== projectId) throw new NotFoundError("concept", conceptId);
}

/** Retry Nano Banana for one concept whose image failed. The other concepts are untouched. */
export async function retryConceptImage(conceptId: string, deps: { retryImage?: typeof retryConceptImageViaN8n } = {}) {
  return (deps.retryImage ?? retryConceptImageViaN8n)(conceptId);
}

/** A refinement request the database refused; `message` is client-safe. */
export class RefinementRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly activeRevisionId: string | null = null,
  ) {
    super(message);
    this.name = "RefinementRejectedError";
  }
}

const REFINEMENT_REJECTIONS: Record<string, string> = {
  not_found: "That project no longer exists.",
  concept_mismatch: "That concept doesn't belong to this project.",
  busy: "A refinement is already running. Wait for it to finish, then send the next change.",
  invalid_state: "This concept can't be refined right now. The latest state is shown now.",
  no_image: "This concept has no image to refine yet.",
  stale_version:
    "This concept has a newer version than the one you were looking at. It's shown now; send your change again if it still applies.",
  not_retryable: "Only the most recent failed refinement can be retried.",
  invalid_request: "Describe what should change (up to 1000 characters).",
  invalid_version: "That version can't be used.",
};

function rejectRefinement(outcome: string, activeRevisionId: string | null = null): never {
  throw new RefinementRejectedError(outcome, REFINEMENT_REJECTIONS[outcome] ?? "The refinement was rejected.", activeRevisionId);
}

export type RefineInput = {
  projectId: string;
  conceptId: string;
  /** The version the client was looking at (null = the original image). Must still be the current version. */
  baseRevisionId: string | null;
  feedback: string;
};

async function dispatchRefinement(
  db: Database,
  job: RefinementJob,
  startRefinement: typeof startRefinementViaN8n,
  reason: string,
) {
  try {
    await startRefinement(job);
  } catch (err) {
    // n8n never got the job: fail the revision right away so the project returns to review.
    await db.execute(
      sql`select outcome from fail_refinement(${job.revisionId}::uuid, ${reason}, ${JSON.stringify({ code: "dispatch_failed" })}::jsonb)`,
    );
    throw err;
  }
}

/**
 * Refinement: the database validates project + concept + current version together and creates the
 * next revision (concept and project -> REFINING) in one transaction; then n8n interprets the
 * feedback with Claude and edits the current image. Returns the new revision.
 */
export async function refineConcept(
  db: Database,
  input: RefineInput,
  deps: { startRefinement?: typeof startRefinementViaN8n } = {},
): Promise<{ revisionId: string; revisionNumber: number }> {
  const result = await db.execute<{ outcome: string; revision_id: string | null; revision_number: number | null; active_revision_id: string | null }>(
    sql`select * from start_refinement(${input.projectId}::uuid, ${input.conceptId}::uuid, ${input.baseRevisionId}::uuid, ${input.feedback})`,
  );
  const row = result.rows[0];
  if (row?.outcome !== "started" || !row.revision_id) rejectRefinement(row?.outcome ?? "not_found", row?.active_revision_id ?? null);
  await dispatchRefinement(
    db,
    { projectId: input.projectId, conceptId: input.conceptId, revisionId: row.revision_id },
    deps.startRefinement ?? startRefinementViaN8n,
    "The refinement could not be started. Please retry.",
  );
  return { revisionId: row.revision_id, revisionNumber: row.revision_number! };
}

/** Retry a failed refinement in place (same revision, feedback and base version). */
export async function retryRefinement(
  db: Database,
  input: { projectId: string; conceptId: string; revisionId: string },
  deps: { startRefinement?: typeof startRefinementViaN8n } = {},
) {
  const result = await db.execute<{ outcome: string }>(
    sql`select * from retry_refinement(${input.projectId}::uuid, ${input.conceptId}::uuid, ${input.revisionId}::uuid)`,
  );
  const outcome = result.rows[0]?.outcome ?? "not_found";
  if (outcome !== "started") rejectRefinement(outcome);
  await dispatchRefinement(db, input, deps.startRefinement ?? startRefinementViaN8n, "The refinement could not be started. Please retry.");
}

/** "Use this version": make a version (null = original) current and approve the concept. */
export async function useConceptVersion(db: Database, input: { projectId: string; conceptId: string; revisionId: string | null }) {
  const result = await db.execute<{ outcome: string }>(
    sql`select * from use_concept_version(${input.projectId}::uuid, ${input.conceptId}::uuid, ${input.revisionId}::uuid)`,
  );
  const outcome = result.rows[0]?.outcome ?? "not_found";
  if (outcome !== "selected") rejectRefinement(outcome);
}

/** A finalize/views request the database refused; `message` is client-safe. */
export class FinalizationRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FinalizationRejectedError";
  }
}

const FINALIZATION_REJECTIONS: Record<string, string> = {
  not_found: "That project no longer exists.",
  concept_mismatch: "That concept doesn't belong to this project.",
  conflict: "A different version has already been finalized for this project.",
  busy: "A refinement is still running. Finalize once it's done.",
  invalid_state: "This project can't be finalized right now. The latest state is shown now.",
  invalid_version: "That version can't be finalized (it has no stored image).",
  no_design: "This project has no finalized design yet.",
  incomplete: "All four views must be ready before they can be approved.",
};

function rejectFinalization(code: string): never {
  throw new FinalizationRejectedError(code, FINALIZATION_REJECTIONS[code] ?? "The request was rejected.");
}

async function liveFinalDesignId(db: Database, projectId: string): Promise<string> {
  const result = await db.execute<{ id: string }>(
    sql`select id from final_designs where project_id = ${projectId}::uuid and status = 'FINALIZED' limit 1`,
  );
  const id = result.rows[0]?.id;
  if (!id) rejectFinalization("no_design");
  return id;
}

/**
 * FINALIZE DESIGN: the exact concept version (revisionId null = the original image) becomes the
 * canonical design in one transaction (project -> FINALIZING), then n8n generates the four views.
 * Repeating the same request is harmless (idempotent). Returns whether view generation started.
 */
export async function finalizeDesign(
  db: Database,
  input: { projectId: string; conceptId: string; revisionId: string | null },
  deps: { generateViews?: typeof generateViewsViaN8n } = {},
): Promise<{ finalDesignId: string; viewsStarted: boolean }> {
  const result = await db.execute<{ outcome: string; final_design_id: string | null; project_status: string | null }>(
    sql`select * from finalize_design(${input.projectId}::uuid, ${input.conceptId}::uuid, ${input.revisionId}::uuid)`,
  );
  const row = result.rows[0];
  const outcome = row?.outcome ?? "not_found";
  if ((outcome !== "finalized" && outcome !== "already_finalized") || !row?.final_design_id) rejectFinalization(outcome);
  // A repeated request only (re)starts views if the first one never got them going.
  if (outcome === "already_finalized" && row.project_status !== "FINALIZING") {
    return { finalDesignId: row.final_design_id, viewsStarted: true };
  }
  try {
    await (deps.generateViews ?? generateViewsViaN8n)({ projectId: input.projectId, finalDesignId: row.final_design_id });
  } catch (err) {
    // A concurrent duplicate already started them: that's the outcome the client wanted.
    if (!(err instanceof N8nRejectedError && ["views_in_progress", "nothing_to_do"].includes(err.code))) throw err;
  }
  return { finalDesignId: row.final_design_id, viewsStarted: true };
}

/**
 * Starts views of the finalized design: all four on the first run (e.g. after finalizing, if n8n was
 * unreachable then), every failed view on a retry, or exactly `viewTypes` ("regenerate this view").
 */
export async function generateViews(
  db: Database,
  projectId: string,
  viewTypes?: ViewType[],
  deps: { generateViews?: typeof generateViewsViaN8n } = {},
) {
  const finalDesignId = await liveFinalDesignId(db, projectId);
  return (deps.generateViews ?? generateViewsViaN8n)({ projectId, finalDesignId, viewTypes });
}

/** "Regenerate this view": a new version of one view, from the canonical master image. */
export async function regenerateView(
  db: Database,
  projectId: string,
  viewType: ViewType,
  deps: { generateViews?: typeof generateViewsViaN8n } = {},
) {
  return generateViews(db, projectId, [viewType], deps);
}

/** Longest a view job may run (n8n limit 10 min), and the whole views run (Claude + images). */
export const VIEW_JOB_DEADLINE_MS = 11 * 60_000;
export const VIEWS_RUN_DEADLINE_MS = 31 * 60_000;

/**
 * Lazy recovery for views whose n8n execution died: claimed jobs past the deadline fail, unclaimed
 * views (instructions never arrived) fail after the run deadline; when nothing is running any more and
 * all four are ready, the project moves on to review.
 */
export async function reapStaleViewJobs(db: Database, projectId: string, now = new Date()): Promise<number> {
  const jobCutoff = new Date(now.getTime() - VIEW_JOB_DEADLINE_MS);
  const runCutoff = new Date(now.getTime() - VIEWS_RUN_DEADLINE_MS);
  const stuck = await db.execute<{ id: string }>(sql`
    select v.id from final_views v join projects p on p.id = v.project_id
    where v.project_id = ${projectId}::uuid and p.status = 'GENERATING_VIEWS' and v.status = 'GENERATING'
      and ((v.image_requested_at is not null and v.image_requested_at < ${jobCutoff.toISOString()}::timestamptz)
        or (v.image_requested_at is null and v.created_at < ${runCutoff.toISOString()}::timestamptz))`);
  for (const v of stuck.rows) {
    await db.execute(
      sql`select outcome from fail_view_image(${v.id}::uuid, ${"The view did not finish. You can retry it."}, ${JSON.stringify({ code: "view_timeout" })}::jsonb)`,
    );
  }
  const idle = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from projects p
    where p.id = ${projectId}::uuid and p.status = 'GENERATING_VIEWS'
      and not exists (select 1 from final_views v where v.project_id = p.id and v.is_current and v.status = 'GENERATING')`);
  if (idle.rows[0]?.n) await db.execute(sql`select outcome from finish_view_generation(${projectId}::uuid, '{}'::uuid[])`);
  return stuck.rows.length;
}

/**
 * APPROVE ALL VIEWS: every current view approved and the project moves to UPLOADING_TO_DRIVE, then
 * n8n delivers the package to Google Drive. If n8n can't be reached, the approval stands and the
 * workspace offers "Start upload". Returns whether the upload started.
 */
export async function approveViewsAndDeliver(
  db: Database,
  projectId: string,
  deps: { startDriveExport?: typeof startDriveExportViaN8n } = {},
): Promise<{ deliveryStarted: boolean }> {
  const result = await db.execute<{ outcome: string }>(sql`select * from approve_all_views(${projectId}::uuid)`);
  const outcome = result.rows[0]?.outcome ?? "not_found";
  if (outcome !== "approved") rejectFinalization(outcome);
  try {
    await deliverToDrive(projectId, deps);
    return { deliveryStarted: true };
  } catch (err) {
    console.error("[n8n] views approved but the Drive upload did not start:", err instanceof Error ? err.message : err);
    return { deliveryStarted: false };
  }
}

/**
 * Start or resume the Drive upload. Safe to repeat: a run already in progress is left alone and
 * finished items are never uploaded twice.
 */
export async function deliverToDrive(projectId: string, deps: { startDriveExport?: typeof startDriveExportViaN8n } = {}) {
  try {
    await (deps.startDriveExport ?? startDriveExportViaN8n)(projectId);
  } catch (err) {
    if (err instanceof N8nRejectedError && err.code === "export_in_progress") return;
    throw err;
  }
}

/** Longest a Drive upload may run before the app shows it as stopped (the next run takes over). */
export const DRIVE_EXPORT_DEADLINE_MS = 21 * 60_000;

/** Marks an upload run that stopped reporting (n8n restart) as failed so the client can retry. */
export async function reapStaleDriveExports(db: Database, projectId: string, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DRIVE_EXPORT_DEADLINE_MS);
  const result = await db.execute(sql`
    update drive_exports set status = 'FAILED', finished_at = now(), error_reason = 'The upload stopped responding. Retry to continue.'
    where project_id = ${projectId}::uuid and status = 'RUNNING' and started_at < ${cutoff.toISOString()}::timestamptz`);
  return result.rowCount ?? 0;
}

