/**
 * Workflow state model: the single TypeScript definition of every status,
 * allowed transition and event type.
 *
 * - Postgres enums in `src/db/schema.ts` are built from these arrays.
 * - The same transitions are seeded into `workflow_status_transitions` and
 *   enforced by database triggers (migration 0001). The database is
 *   authoritative; this module gives the app early, typed errors.
 * - `tests/db/state-machine-sync.test.ts` fails if the two ever drift apart.
 *
 * Changing a transition therefore needs BOTH an edit here AND a new migration
 * that updates `workflow_status_transitions`.
 */

export const PROJECT_STATUSES = [
  "DRAFT",
  "GENERATING_CONCEPTS",
  "CONCEPT_REVIEW",
  "REFINING",
  "FINALIZING",
  "GENERATING_VIEWS",
  "VIEW_REVIEW",
  "UPLOADING_TO_DRIVE",
  "COMPLETED",
  "FAILED",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const CONCEPT_STATUSES = [
  "GENERATING",
  "READY",
  "SELECTED",
  "REJECTED",
  "REFINING",
  "FINAL",
  "FAILED",
] as const;
export type ConceptStatus = (typeof CONCEPT_STATUSES)[number];

export const REVISION_STATUSES = ["GENERATING", "READY", "SELECTED", "FAILED"] as const;
export type RevisionStatus = (typeof REVISION_STATUSES)[number];

export const FINAL_DESIGN_STATUSES = ["PENDING", "FINALIZED", "CANCELLED"] as const;
export type FinalDesignStatus = (typeof FINAL_DESIGN_STATUSES)[number];

export const VIEW_STATUSES = ["GENERATING", "READY", "APPROVED", "FAILED"] as const;
export type ViewStatus = (typeof VIEW_STATUSES)[number];

export const VIEW_TYPES = ["FRONT", "BACK", "LEFT", "RIGHT"] as const;
export type ViewType = (typeof VIEW_TYPES)[number];

export const PROJECT_EVENT_TYPES = [
  "PROJECT_CREATED",
  "CONCEPT_GENERATION_STARTED",
  "CONCEPT_GENERATION_COMPLETED",
  "CONCEPT_SELECTED",
  "CONCEPT_REJECTED",
  "REFINEMENT_STARTED",
  "REVISION_CREATED",
  "DESIGN_FINALIZED",
  "VIEW_GENERATION_STARTED",
  "VIEW_GENERATED",
  "VIEW_APPROVED",
  "DRIVE_UPLOAD_STARTED",
  "DRIVE_UPLOAD_COMPLETED",
  "PROJECT_COMPLETED",
  "GENERATION_FAILED",
] as const;
export type ProjectEventType = (typeof PROJECT_EVENT_TYPES)[number];

/** Entities whose `status` column is guarded by the transition trigger. */
export const WORKFLOW_ENTITIES = ["project", "concept", "revision", "final_design", "final_view"] as const;
export type WorkflowEntity = (typeof WORKFLOW_ENTITIES)[number];

type StateMachine<S extends string> = {
  /** Statuses a newly inserted row may start in. */
  initial: readonly S[];
  /** from -> allowed targets. A status with no entry is terminal. */
  transitions: Readonly<Partial<Record<S, readonly S[]>>>;
};

export const PROJECT_MACHINE: StateMachine<ProjectStatus> = {
  initial: ["DRAFT"],
  transitions: {
    DRAFT: ["GENERATING_CONCEPTS"],
    GENERATING_CONCEPTS: ["CONCEPT_REVIEW", "FAILED"],
    // "Generate more" goes back to GENERATING_CONCEPTS.
    CONCEPT_REVIEW: ["GENERATING_CONCEPTS", "REFINING", "FINALIZING"],
    // A failed refinement is not fatal: the concept keeps its last good image.
    REFINING: ["CONCEPT_REVIEW"],
    FINALIZING: ["GENERATING_VIEWS", "CONCEPT_REVIEW", "FAILED"],
    GENERATING_VIEWS: ["VIEW_REVIEW", "FAILED"],
    // Regenerating one or more views goes back to GENERATING_VIEWS.
    VIEW_REVIEW: ["GENERATING_VIEWS", "UPLOADING_TO_DRIVE"],
    UPLOADING_TO_DRIVE: ["COMPLETED", "FAILED"],
    // Retry only. The trigger further restricts this to the status the
    // project failed from (`projects.failed_from_status`).
    FAILED: ["GENERATING_CONCEPTS", "FINALIZING", "GENERATING_VIEWS", "UPLOADING_TO_DRIVE"],
    // COMPLETED is terminal.
  },
};

export const CONCEPT_MACHINE: StateMachine<ConceptStatus> = {
  initial: ["GENERATING", "READY"],
  transitions: {
    GENERATING: ["READY", "FAILED"],
    READY: ["SELECTED", "REJECTED", "REFINING", "FINAL"],
    SELECTED: ["READY", "REJECTED", "REFINING", "FINAL"],
    REJECTED: ["READY"],
    REFINING: ["READY", "SELECTED"],
    FAILED: ["GENERATING"],
    // FINAL is terminal.
  },
};

export const REVISION_MACHINE: StateMachine<RevisionStatus> = {
  initial: ["GENERATING", "READY"],
  transitions: {
    GENERATING: ["READY", "FAILED"],
    READY: ["SELECTED"],
    SELECTED: ["READY"],
    // FAILED is terminal: a new refinement creates a new revision.
  },
};

export const FINAL_DESIGN_MACHINE: StateMachine<FinalDesignStatus> = {
  initial: ["PENDING"],
  transitions: {
    PENDING: ["FINALIZED", "CANCELLED"],
  },
};

export const VIEW_MACHINE: StateMachine<ViewStatus> = {
  initial: ["GENERATING"],
  transitions: {
    GENERATING: ["READY", "FAILED"],
    READY: ["APPROVED"],
    APPROVED: ["READY"],
    // FAILED is terminal: regeneration inserts a new version row.
  },
};

export const STATE_MACHINES = {
  project: PROJECT_MACHINE,
  concept: CONCEPT_MACHINE,
  revision: REVISION_MACHINE,
  final_design: FINAL_DESIGN_MACHINE,
  final_view: VIEW_MACHINE,
} as const satisfies Record<WorkflowEntity, StateMachine<string>>;

/** Pseudo "from" status used for inserts in `workflow_status_transitions`. */
export const NEW_ROW = "(new)";

export class InvalidStateTransitionError extends Error {
  constructor(
    readonly entity: WorkflowEntity,
    readonly from: string,
    readonly to: string,
  ) {
    super(`invalid_state_transition: ${entity} ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}

export function canTransition<E extends WorkflowEntity>(entity: E, from: string, to: string): boolean {
  const machine: StateMachine<string> = STATE_MACHINES[entity];
  if (from === NEW_ROW) return machine.initial.includes(to);
  return machine.transitions[from]?.includes(to) ?? false;
}

export function assertTransition(entity: WorkflowEntity, from: string, to: string): void {
  if (!canTransition(entity, from, to)) {
    throw new InvalidStateTransitionError(entity, from, to);
  }
}

/** Flattened (entity, from, to) rows, as seeded into `workflow_status_transitions`. */
export function allTransitionRows(): { entity: WorkflowEntity; from: string; to: string }[] {
  const rows: { entity: WorkflowEntity; from: string; to: string }[] = [];
  for (const entity of WORKFLOW_ENTITIES) {
    const machine: StateMachine<string> = STATE_MACHINES[entity];
    for (const to of machine.initial) rows.push({ entity, from: NEW_ROW, to });
    for (const [from, targets] of Object.entries(machine.transitions)) {
      for (const to of targets ?? []) rows.push({ entity, from, to });
    }
  }
  return rows;
}
