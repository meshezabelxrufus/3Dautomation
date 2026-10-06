/**
 * Read models for the workflow UI and the GET API. Returns client-safe DTOs.
 */
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db/client";
import {
  assets,
  concepts,
  driveExports,
  driveItems,
  finalDesigns,
  finalViews,
  projectEvents,
  projects,
  revisions,
  type Asset,
  type Concept,
  type Project,
} from "@/db/schema";
import { VIEW_TYPES } from "@/server/domain/workflow-states";
import { statusMeta } from "@/lib/workflow-ui";
import type {
  ConceptDTO,
  DeliveryDTO,
  FinalViewsDTO,
  ProjectDTO,
  ProjectStatusDTO,
  ProjectSummaryDTO,
  RevisionDTO,
} from "@/lib/api/types";

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

function toSummary(p: Project, coverImageUrl: string | null, conceptCount: number): ProjectSummaryDTO {
  return {
    id: p.id,
    projectName: p.projectName,
    clientName: p.clientName,
    status: p.status,
    failedFromStatus: p.failedFromStatus,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
    finalizedAt: isoOrNull(p.finalizedAt),
    coverImageUrl,
    conceptCount,
  };
}

function toConcept(c: Concept, a: Asset | null): ConceptDTO {
  return {
    id: c.id,
    projectId: c.projectId,
    conceptNumber: c.conceptNumber,
    title: c.title,
    description: c.description,
    creativeDirection: c.creativeDirection,
    visualCharacteristics: c.visualCharacteristics,
    shapeLanguage: c.shapeLanguage,
    keyFeatures: c.keyFeatures,
    materials: c.materials,
    generationPrompt: c.generationPrompt,
    imageUrl: c.imageUrl,
    imageError: c.status === "FAILED" ? c.imageError : null,
    imageRequestedAt: isoOrNull(c.imageRequestedAt),
    image: a
      ? { model: a.model, provider: a.provider, width: a.width, height: a.height, createdAt: iso(a.createdAt) }
      : null,
    activeRevisionId: c.activeRevisionId,
    status: c.status,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
}

/** Cover image + concept count for a set of projects, in two queries. */
async function coversFor(db: DbExecutor, projectIds: string[]) {
  const covers = new Map<string, string>();
  const counts = new Map<string, number>();
  if (projectIds.length === 0) return { covers, counts };

  const designs = await db
    .select({ projectId: finalDesigns.projectId, masterImage: finalDesigns.masterImage })
    .from(finalDesigns)
    .where(and(inArray(finalDesigns.projectId, projectIds), ne(finalDesigns.status, "CANCELLED")));
  for (const d of designs) covers.set(d.projectId, d.masterImage);

  const rows = await db
    .select({ projectId: concepts.projectId, imageUrl: concepts.imageUrl, status: concepts.status })
    .from(concepts)
    .where(inArray(concepts.projectId, projectIds))
    .orderBy(asc(concepts.conceptNumber));
  for (const r of rows) {
    counts.set(r.projectId, (counts.get(r.projectId) ?? 0) + 1);
    if (!covers.has(r.projectId) && r.imageUrl && r.status !== "REJECTED") covers.set(r.projectId, r.imageUrl);
  }
  return { covers, counts };
}

export async function listProjects(db: DbExecutor, limit = 100): Promise<ProjectSummaryDTO[]> {
  const rows = await db.select().from(projects).orderBy(desc(projects.updatedAt)).limit(limit);
  const { covers, counts } = await coversFor(
    db,
    rows.map((p) => p.id),
  );
  return rows.map((p) => toSummary(p, covers.get(p.id) ?? null, counts.get(p.id) ?? 0));
}

export async function getProject(db: DbExecutor, projectId: string): Promise<ProjectDTO | null> {
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!p) return null;
  const { covers, counts } = await coversFor(db, [p.id]);
  const [started] = await db
    .select({ payload: projectEvents.payload })
    .from(projectEvents)
    .where(and(eq(projectEvents.projectId, projectId), eq(projectEvents.eventType, "CONCEPT_GENERATION_STARTED")))
    .orderBy(desc(projectEvents.id))
    .limit(1);
  const requested = started?.payload?.requestedCount;
  return {
    ...toSummary(p, covers.get(p.id) ?? null, counts.get(p.id) ?? 0),
    designBrief: p.designBrief,
    failureReason: p.failureReason,
    requestedConceptCount: typeof requested === "number" ? requested : null,
  };
}

export async function getProjectStatus(db: DbExecutor, projectId: string): Promise<ProjectStatusDTO | null> {
  const result = await db.execute<{
    status: Project["status"];
    failure_reason: string | null;
    updated_at: string;
    change_token: string;
    images_pending: number;
    revisions_pending: number;
  }>(sql`
    select
      p.status,
      p.failure_reason,
      p.updated_at::text as updated_at,
      (select count(*)::int from ${concepts} c where c.project_id = p.id and c.status = 'GENERATING') as images_pending,
      (select count(*)::int from ${revisions} r join ${concepts} c on c.id = r.concept_id
         where c.project_id = p.id and r.status = 'GENERATING') as revisions_pending,
      concat_ws(':',
        extract(epoch from greatest(
          p.updated_at,
          (select max(c.updated_at) from ${concepts} c where c.project_id = p.id),
          (select max(r.created_at) from ${revisions} r join ${concepts} c on c.id = r.concept_id where c.project_id = p.id),
          (select max(coalesce(d.finalized_at, d.created_at)) from ${finalDesigns} d where d.project_id = p.id),
          (select max(v.updated_at) from ${finalViews} v where v.project_id = p.id),
          (select max(i.updated_at) from ${driveItems} i where i.project_id = p.id),
          (select max(coalesce(x.finished_at, x.started_at)) from ${driveExports} x where x.project_id = p.id)
        ))::text,
        (select coalesce(max(e.id), 0) from ${projectEvents} e where e.project_id = p.id)::text,
        (select count(*) from ${revisions} r join ${concepts} c on c.id = r.concept_id
           where c.project_id = p.id and r.status <> 'GENERATING')::text
      ) as change_token
    from ${projects} p
    where p.id = ${projectId}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    projectId,
    status: row.status,
    failureReason: row.failure_reason,
    isBusy: statusMeta(row.status).busy || Number(row.images_pending) > 0 || Number(row.revisions_pending) > 0,
    imagesPending: Number(row.images_pending),
    changeToken: row.change_token,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function getConcepts(db: DbExecutor, projectId: string): Promise<ConceptDTO[]> {
  const rows = await db
    .select({ c: concepts, a: assets })
    .from(concepts)
    .leftJoin(assets, eq(assets.id, concepts.imageAssetId))
    .where(eq(concepts.projectId, projectId))
    .orderBy(asc(concepts.conceptNumber));
  return rows.map(({ c, a }) => toConcept(c, a));
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((c) => typeof c === "string") ? (value as string[]) : null;
}

const interpretationText = (value: Record<string, unknown> | null) =>
  typeof value?.summary === "string" ? value.summary : null;

/** All revisions of all concepts in the project, oldest first per concept. */
export async function getRevisions(db: DbExecutor, projectId: string): Promise<RevisionDTO[]> {
  const rows = await db
    .select({ r: revisions, activeRevisionId: concepts.activeRevisionId })
    .from(revisions)
    .innerJoin(concepts, eq(concepts.id, revisions.conceptId))
    .where(eq(concepts.projectId, projectId))
    .orderBy(asc(concepts.conceptNumber), asc(revisions.revisionNumber));
  const newest = new Map<string, number>();
  for (const { r } of rows) newest.set(r.conceptId, Math.max(newest.get(r.conceptId) ?? 0, r.revisionNumber));
  return rows.map(({ r, activeRevisionId }) => {
    const ii = r.interpretedInstruction ?? null;
    return {
      id: r.id,
      conceptId: r.conceptId,
      revisionNumber: r.revisionNumber,
      baseRevisionId: r.baseRevisionId,
      clientFeedback: r.clientFeedback,
      interpretationSummary: stringList(ii?.changes),
      interpretation: interpretationText(ii),
      preserved: stringList(ii?.preserve),
      generationPrompt: r.generationPrompt,
      imageUrl: r.imageUrl,
      errorReason: r.status === "FAILED" ? r.errorReason : null,
      retryable: r.status === "FAILED" && newest.get(r.conceptId) === r.revisionNumber && r.baseRevisionId === activeRevisionId,
      status: r.status,
      createdAt: iso(r.createdAt),
    };
  });
}

/** The live final design (if any) and the current version of each view, in FRONT/BACK/LEFT/RIGHT order. */
export async function getFinalViews(db: DbExecutor, projectId: string): Promise<FinalViewsDTO> {
  const [row] = await db
    .select({ d: finalDesigns, c: concepts, revisionNumber: revisions.revisionNumber })
    .from(finalDesigns)
    .innerJoin(concepts, eq(concepts.id, finalDesigns.approvedConceptId))
    .leftJoin(revisions, eq(revisions.id, finalDesigns.approvedRevisionId))
    .where(and(eq(finalDesigns.projectId, projectId), ne(finalDesigns.status, "CANCELLED")))
    .orderBy(desc(finalDesigns.createdAt))
    .limit(1);
  const views = await db
    .select()
    .from(finalViews)
    .where(and(eq(finalViews.projectId, projectId), eq(finalViews.isCurrent, true)));
  views.sort((a, b) => VIEW_TYPES.indexOf(a.viewType) - VIEW_TYPES.indexOf(b.viewType));
  const prompts = row?.d.viewPrompts ?? null;
  return {
    delivery: await getDelivery(db, projectId),
    finalDesign: row
      ? {
          id: row.d.id,
          approvedConceptId: row.d.approvedConceptId,
          approvedRevisionId: row.d.approvedRevisionId,
          approvedRevisionNumber: row.revisionNumber ?? 0,
          conceptNumber: row.c.conceptNumber,
          conceptTitle: row.c.title,
          conceptDescription: row.c.description,
          masterImage: row.d.masterImage,
          status: row.d.status,
          designSummary: typeof prompts?.design_summary === "string" ? prompts.design_summary : null,
          invariants: stringList(prompts?.invariants) ?? [],
          createdAt: iso(row.d.createdAt),
          finalizedAt: isoOrNull(row.d.finalizedAt),
        }
      : null,
    views: views.map((v) => ({
      id: v.id,
      viewType: v.viewType,
      versionNumber: v.versionNumber,
      imageUrl: v.imageUrl,
      generationPrompt: v.generationPrompt,
      errorReason: v.status === "FAILED" ? v.errorReason : null,
      driveFileId: v.driveFileId,
      status: v.status,
      updatedAt: iso(v.updatedAt),
    })),
  };
}

const PACKAGE_ORDER = ["file:MASTER", "file:FRONT", "file:BACK", "file:LEFT", "file:RIGHT", "file:METADATA"];

/** Google Drive delivery state: latest run, project folder, and the package files. No credentials. */
export async function getDelivery(db: DbExecutor, projectId: string): Promise<DeliveryDTO> {
  const [run] = await db
    .select()
    .from(driveExports)
    .where(eq(driveExports.projectId, projectId))
    .orderBy(desc(driveExports.startedAt))
    .limit(1);
  const items = await db.select().from(driveItems).where(eq(driveItems.projectId, projectId));
  const folder = items.find((i) => i.itemKey === "folder:project" && i.driveFileId);
  const byKey = new Map(items.map((i) => [i.itemKey, i]));
  const packageItems = PACKAGE_ORDER.map((key) => {
    const i = byKey.get(key);
    const name = key === "file:METADATA" ? "project.json" : `${key.slice(5)}.png`;
    return {
      key,
      name: i?.name ?? name,
      kind: "FILE" as const,
      status: (i?.status ?? "PENDING") as "PENDING" | "DONE" | "FAILED",
      error: i?.status === "FAILED" ? i.errorReason : null,
      driveUrl: i?.status === "DONE" ? i.driveUrl : null,
    };
  });
  const failedElsewhere = items
    .filter((i) => i.status === "FAILED" && !PACKAGE_ORDER.includes(i.itemKey))
    .map((i) => ({ key: i.itemKey, name: i.name, kind: i.kind as "FOLDER" | "FILE", status: "FAILED" as const, error: i.errorReason, driveUrl: null }));
  return {
    run: run
      ? {
          status: run.status as "RUNNING" | "COMPLETED" | "FAILED",
          mode: run.mode as "live" | "test",
          startedAt: iso(run.startedAt),
          finishedAt: isoOrNull(run.finishedAt),
          errorReason: run.errorReason,
        }
      : null,
    folder: folder ? { name: folder.name, driveFileId: folder.driveFileId!, url: folder.driveUrl } : null,
    items: [...packageItems, ...failedElsewhere],
    done: items.filter((i) => i.status === "DONE").length,
    total: items.length,
  };
}

export type StudioSummaryDTO = {
  total: number;
  /** Waiting on the client: concepts or views to review, or a failed step to retry. */
  needsReview: number;
  /** Backend (AI/n8n) is working on them. */
  inProgress: number;
  delivered: number;
  /** Most recently touched unfinished project, for "pick up where you left off". */
  continueWith: ProjectSummaryDTO | null;
};

const REVIEW_STATUSES = new Set<Project["status"]>(["CONCEPT_REVIEW", "VIEW_REVIEW", "FAILED"]);

/** Pure classification of project statuses (rows newest first). */
export function summarizeStatuses(rows: { id: string; status: Project["status"] }[]) {
  return {
    total: rows.length,
    needsReview: rows.filter((r) => REVIEW_STATUSES.has(r.status)).length,
    inProgress: rows.filter((r) => statusMeta(r.status).busy).length,
    delivered: rows.filter((r) => r.status === "COMPLETED").length,
    continueId: rows.find((r) => r.status !== "COMPLETED")?.id ?? null,
  };
}

export async function getStudioSummary(db: DbExecutor): Promise<StudioSummaryDTO> {
  const rows = await db
    .select({ id: projects.id, status: projects.status })
    .from(projects)
    .orderBy(desc(projects.updatedAt));
  const { continueId, ...counts } = summarizeStatuses(rows);
  let continueWith: ProjectSummaryDTO | null = null;
  if (continueId) {
    const [p] = await db.select().from(projects).where(eq(projects.id, continueId));
    const { covers, counts } = await coversFor(db, [continueId]);
    continueWith = p ? toSummary(p, covers.get(p.id) ?? null, counts.get(p.id) ?? 0) : null;
  }
  return { ...counts, continueWith };
}
