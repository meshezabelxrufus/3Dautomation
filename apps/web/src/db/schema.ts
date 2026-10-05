/**
 * Database schema for the Milestone 1 design workflow (Postgres, database `app`).
 *
 * Status columns are Postgres enums built from `src/server/domain/workflow-states.ts`.
 * Valid status transitions, cross-entity guards and timestamps are enforced by
 * triggers in `drizzle/0001_workflow_triggers.sql`. The database is authoritative
 * for workflow state, not the frontend.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  CONCEPT_STATUSES,
  FINAL_DESIGN_STATUSES,
  PROJECT_EVENT_TYPES,
  PROJECT_STATUSES,
  REVISION_STATUSES,
  VIEW_STATUSES,
  VIEW_TYPES,
  WORKFLOW_ENTITIES,
} from "../server/domain/workflow-states";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const projectStatus = pgEnum("project_status", PROJECT_STATUSES);
export const conceptStatus = pgEnum("concept_status", CONCEPT_STATUSES);
export const revisionStatus = pgEnum("revision_status", REVISION_STATUSES);
export const finalDesignStatus = pgEnum("final_design_status", FINAL_DESIGN_STATUSES);
export const viewType = pgEnum("view_type", VIEW_TYPES);
export const viewStatus = pgEnum("view_status", VIEW_STATUSES);
export const projectEventType = pgEnum("project_event_type", PROJECT_EVENT_TYPES);
export const workflowEntity = pgEnum("workflow_entity", WORKFLOW_ENTITIES);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectName: text("project_name").notNull(),
    clientName: text("client_name").notNull(),
    designBrief: text("design_brief").notNull(),
    status: projectStatus("status").notNull().default("DRAFT"),
    /** Set by trigger when entering FAILED. A retry may only return to this status. */
    failedFromStatus: projectStatus("failed_from_status"),
    failureReason: text("failure_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Set by trigger when the project reaches COMPLETED. */
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (t) => [
    check("projects_project_name_len", sql`char_length(${t.projectName}) between 1 and 200`),
    check("projects_client_name_len", sql`char_length(${t.clientName}) between 1 and 200`),
    check("projects_design_brief_len", sql`char_length(${t.designBrief}) between 1 and 4000`),
    check(
      "projects_failed_from_status_consistent",
      sql`(${t.status} = 'FAILED') = (${t.failedFromStatus} is not null)`,
    ),
    check(
      "projects_finalized_at_consistent",
      sql`(${t.status} = 'COMPLETED') = (${t.finalizedAt} is not null)`,
    ),
    index("projects_status_updated_at_idx").on(t.status, t.updatedAt),
    index("projects_created_at_idx").on(t.createdAt),
    index("projects_client_name_idx").on(t.clientName),
  ],
);

// ---------------------------------------------------------------------------
// concepts
// ---------------------------------------------------------------------------

export const concepts = pgTable(
  "concepts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    conceptNumber: integer("concept_number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    creativeDirection: text("creative_direction"),
    visualCharacteristics: text("visual_characteristics"),
    shapeLanguage: text("shape_language"),
    keyFeatures: text("key_features").array().notNull().default(sql`'{}'::text[]`),
    materials: text("materials").array().notNull().default(sql`'{}'::text[]`),
    generationPrompt: text("generation_prompt"),
    /** Storage key or URL of the current concept image (null until generated). */
    imageUrl: text("image_url"),
    status: conceptStatus("status").notNull().default("GENERATING"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("concepts_project_concept_number_key").on(t.projectId, t.conceptNumber),
    // Target for composite FKs that must stay inside one project.
    unique("concepts_id_project_key").on(t.id, t.projectId),
    check("concepts_concept_number_positive", sql`${t.conceptNumber} >= 1`),
    // Concepts are reviewable as structured text before images exist (images arrive in a
    // later step); only a FINAL concept must have an image.
    check("concepts_final_requires_image", sql`${t.status} <> 'FINAL' or ${t.imageUrl} is not null`),
    index("concepts_project_status_idx").on(t.projectId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// revisions
// ---------------------------------------------------------------------------

export const revisions = pgTable(
  "revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    clientFeedback: text("client_feedback").notNull(),
    /** Claude's structured interpretation of the feedback (changes, preserve, edit prompt). */
    interpretedInstruction: jsonb("interpreted_instruction").$type<Record<string, unknown>>(),
    generationPrompt: text("generation_prompt"),
    imageUrl: text("image_url"),
    status: revisionStatus("status").notNull().default("GENERATING"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("revisions_concept_revision_number_key").on(t.conceptId, t.revisionNumber),
    unique("revisions_id_concept_key").on(t.id, t.conceptId),
    check("revisions_revision_number_positive", sql`${t.revisionNumber} >= 1`),
    check("revisions_client_feedback_len", sql`char_length(${t.clientFeedback}) between 1 and 1000`),
    check(
      "revisions_image_required",
      sql`${t.status} in ('GENERATING', 'FAILED') or ${t.imageUrl} is not null`,
    ),
    check(
      "revisions_interpreted_instruction_object",
      sql`${t.interpretedInstruction} is null or jsonb_typeof(${t.interpretedInstruction}) = 'object'`,
    ),
    // One refinement in flight per concept; at most one selected revision per concept.
    uniqueIndex("revisions_one_generating_per_concept")
      .on(t.conceptId)
      .where(sql`${t.status} = 'GENERATING'`),
    uniqueIndex("revisions_one_selected_per_concept")
      .on(t.conceptId)
      .where(sql`${t.status} = 'SELECTED'`),
  ],
);

// ---------------------------------------------------------------------------
// final_designs
// ---------------------------------------------------------------------------

export const finalDesigns = pgTable(
  "final_designs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    approvedConceptId: uuid("approved_concept_id").notNull(),
    approvedRevisionId: uuid("approved_revision_id"),
    /** Storage key or URL of the approved master image (concept or revision image). */
    masterImage: text("master_image").notNull(),
    status: finalDesignStatus("status").notNull().default("PENDING"),
    createdAt: createdAt(),
    /** Set by trigger when status becomes FINALIZED. */
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  },
  (t) => [
    unique("final_designs_id_project_key").on(t.id, t.projectId),
    // The approved concept must belong to the same project.
    foreignKey({
      name: "final_designs_concept_same_project_fk",
      columns: [t.approvedConceptId, t.projectId],
      foreignColumns: [concepts.id, concepts.projectId],
    }),
    // The approved revision (optional) must belong to the approved concept.
    foreignKey({
      name: "final_designs_revision_same_concept_fk",
      columns: [t.approvedRevisionId, t.approvedConceptId],
      foreignColumns: [revisions.id, revisions.conceptId],
    }),
    check(
      "final_designs_finalized_at_consistent",
      sql`(${t.status} = 'FINALIZED') = (${t.finalizedAt} is not null)`,
    ),
    // At most one live (non-cancelled) final design per project.
    uniqueIndex("final_designs_one_active_per_project")
      .on(t.projectId)
      .where(sql`${t.status} <> 'CANCELLED'`),
    index("final_designs_approved_concept_idx").on(t.approvedConceptId),
    index("final_designs_approved_revision_idx").on(t.approvedRevisionId),
  ],
);

// ---------------------------------------------------------------------------
// final_views
// ---------------------------------------------------------------------------

export const finalViews = pgTable(
  "final_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    finalDesignId: uuid("final_design_id").notNull(),
    viewType: viewType("view_type").notNull(),
    /** Regeneration inserts a new version; only one row per (project, view_type) is current. */
    versionNumber: integer("version_number").notNull().default(1),
    isCurrent: boolean("is_current").notNull().default(true),
    imageUrl: text("image_url"),
    driveFileId: text("drive_file_id"),
    status: viewStatus("status").notNull().default("GENERATING"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The final design must belong to the same project.
    foreignKey({
      name: "final_views_design_same_project_fk",
      columns: [t.finalDesignId, t.projectId],
      foreignColumns: [finalDesigns.id, finalDesigns.projectId],
    }),
    unique("final_views_project_type_version_key").on(t.projectId, t.viewType, t.versionNumber),
    check("final_views_version_positive", sql`${t.versionNumber} >= 1`),
    check(
      "final_views_image_required",
      sql`${t.status} in ('GENERATING', 'FAILED') or ${t.imageUrl} is not null`,
    ),
    uniqueIndex("final_views_one_current_per_type")
      .on(t.projectId, t.viewType)
      .where(sql`${t.isCurrent}`),
    index("final_views_project_status_idx").on(t.projectId, t.status),
    index("final_views_final_design_idx").on(t.finalDesignId),
  ],
);

// ---------------------------------------------------------------------------
// project_events (append-only audit log)
// ---------------------------------------------------------------------------

export const projectEvents = pgTable(
  "project_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    eventType: projectEventType("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    check("project_events_payload_object", sql`jsonb_typeof(${t.payload}) = 'object'`),
    index("project_events_project_created_idx").on(t.projectId, t.createdAt),
    index("project_events_type_created_idx").on(t.eventType, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// workflow_status_transitions (reference data read by the transition trigger)
// ---------------------------------------------------------------------------

export const workflowStatusTransitions = pgTable(
  "workflow_status_transitions",
  {
    entity: workflowEntity("entity").notNull(),
    /** "(new)" for allowed initial statuses on insert. */
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
  },
  (t) => [primaryKey({ columns: [t.entity, t.fromStatus, t.toStatus] })],
);

export type Project = typeof projects.$inferSelect;
export type Concept = typeof concepts.$inferSelect;
export type Revision = typeof revisions.$inferSelect;
export type FinalDesign = typeof finalDesigns.$inferSelect;
export type FinalView = typeof finalViews.$inferSelect;
export type ProjectEvent = typeof projectEvents.$inferSelect;
