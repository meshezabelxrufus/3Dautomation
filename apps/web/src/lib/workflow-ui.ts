/**
 * Presentation metadata for workflow statuses. UI decisions are derived from the
 * database status (the source of truth), never from local "isGenerating" flags.
 */
import type { ProjectStatus } from "@/server/domain/workflow-states";

export type StatusTone = "neutral" | "working" | "attention" | "success" | "danger";

/** The six stages a client sees, in order. */
export const STAGES = ["Brief", "Ideas", "Refine", "Final design", "Views", "Delivered"] as const;
export type StageIndex = 0 | 1 | 2 | 3 | 4 | 5;

type StatusMeta = {
  label: string;
  /** One short sentence for the client about what is happening or what to do next. */
  description: string;
  tone: StatusTone;
  /** True while the backend (n8n / AI) is working and the UI should poll. */
  busy: boolean;
  stage: StageIndex;
};

export const STATUS_META: Record<ProjectStatus, StatusMeta> = {
  DRAFT: {
    label: "Draft",
    description: "The brief is saved. Generate ideas when you're ready.",
    tone: "neutral",
    busy: false,
    stage: 0,
  },
  GENERATING_CONCEPTS: {
    label: "Generating concepts",
    description: "Claude is turning the brief into distinct design directions. This usually takes a minute or two.",
    tone: "working",
    busy: true,
    stage: 1,
  },
  CONCEPT_REVIEW: {
    label: "Concepts ready",
    description: "Review the concepts: shortlist favourites and reject the rest.",
    tone: "attention",
    busy: false,
    stage: 1,
  },
  REFINING: {
    label: "Refining",
    description: "Applying your feedback to the selected concept.",
    tone: "working",
    busy: true,
    stage: 2,
  },
  FINALIZING: {
    label: "Finalizing",
    description: "Locking the approved design as the master image.",
    tone: "working",
    busy: true,
    stage: 3,
  },
  GENERATING_VIEWS: {
    label: "Generating views",
    description: "Producing front, back, left and right views of the final design.",
    tone: "working",
    busy: true,
    stage: 4,
  },
  VIEW_REVIEW: {
    label: "Views ready",
    description: "Check all four views, then approve them for delivery.",
    tone: "attention",
    busy: false,
    stage: 4,
  },
  UPLOADING_TO_DRIVE: {
    label: "Uploading",
    description: "Delivering the approved images to Google Drive.",
    tone: "working",
    busy: true,
    stage: 5,
  },
  COMPLETED: {
    label: "Completed",
    description: "The final design and its four views are in Google Drive.",
    tone: "success",
    busy: false,
    stage: 5,
  },
  FAILED: {
    label: "Needs attention",
    description: "A step failed. You can retry it.",
    tone: "danger",
    busy: false,
    stage: 1,
  },
};

export function statusMeta(status: ProjectStatus): StatusMeta {
  return STATUS_META[status];
}

/** Stage reached, taking a failure into account (stay on the stage that failed). */
export function stageFor(status: ProjectStatus, failedFrom?: ProjectStatus | null): StageIndex {
  if (status === "FAILED" && failedFrom) return STATUS_META[failedFrom].stage;
  return STATUS_META[status].stage;
}

/** 0–1 progress through the six stages (for compact progress indicators). */
export function progressFor(status: ProjectStatus, failedFrom?: ProjectStatus | null): number {
  if (status === "COMPLETED") return 1;
  return stageFor(status, failedFrom) / (STAGES.length - 1);
}

export type WorkspaceState =
  | "empty"
  | "generating"
  | "concepts-ready"
  | "refining"
  | "finalizing"
  | "generating-views"
  | "view-review"
  | "uploading"
  | "completed"
  | "error";

export function workspaceStateFor(status: ProjectStatus): WorkspaceState {
  switch (status) {
    case "DRAFT":
      return "empty";
    case "GENERATING_CONCEPTS":
      return "generating";
    case "CONCEPT_REVIEW":
      return "concepts-ready";
    case "REFINING":
      return "refining";
    case "FINALIZING":
      return "finalizing";
    case "GENERATING_VIEWS":
      return "generating-views";
    case "VIEW_REVIEW":
      return "view-review";
    case "UPLOADING_TO_DRIVE":
      return "uploading";
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "error";
  }
}

export const VIEW_LABELS = { FRONT: "Front", BACK: "Back", LEFT: "Left", RIGHT: "Right" } as const;
