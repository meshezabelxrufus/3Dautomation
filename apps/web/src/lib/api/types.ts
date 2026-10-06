/**
 * Client-safe API contract (DTOs) for the workflow read endpoints.
 * Dates are ISO strings so the same shapes work for Server Components,
 * Route Handlers (JSON) and the browser.
 */
import type {
  ConceptStatus,
  FinalDesignStatus,
  ProjectEventType,
  ProjectStatus,
  RevisionStatus,
  ViewStatus,
  ViewType,
} from "@/server/domain/workflow-states";

export type ProjectSummaryDTO = {
  id: string;
  projectName: string;
  clientName: string;
  status: ProjectStatus;
  /** Status the project failed from (only when status is FAILED). */
  failedFromStatus: ProjectStatus | null;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  /** Image shown on the project card (final master image, else first ready concept). */
  coverImageUrl: string | null;
  conceptCount: number;
};

export type ProjectDTO = ProjectSummaryDTO & {
  designBrief: string;
  failureReason: string | null;
  /** Concept count requested by the last CONCEPT_GENERATION_STARTED event. */
  requestedConceptCount: number | null;
};

/**
 * Lightweight payload for polling. `changeToken` changes whenever anything visible
 * in the workspace changes, so the client refetches details only when needed.
 */
export type ProjectStatusDTO = {
  projectId: string;
  status: ProjectStatus;
  failureReason: string | null;
  /** True while any backend job runs: the project step, a concept image, or a refinement. */
  isBusy: boolean;
  /** Concept images still being generated (also counts single-image retries in review). */
  imagesPending: number;
  changeToken: string;
  updatedAt: string;
};

export type ConceptDTO = {
  id: string;
  projectId: string;
  conceptNumber: number;
  title: string;
  description: string;
  creativeDirection: string | null;
  visualCharacteristics: string | null;
  shapeLanguage: string | null;
  keyFeatures: string[];
  materials: string[];
  /** Prompt for the image model, written by Claude. */
  generationPrompt: string | null;
  /** Served by the app from its own storage (/api/assets/<id>), never a provider URL. */
  imageUrl: string | null;
  /** Client-safe reason the image failed (status FAILED); the concept can be retried. */
  imageError: string | null;
  /** When the current image job started (null before the first one). */
  imageRequestedAt: string | null;
  image: ConceptImageDTO | null;
  /** Current version: null = the original image (revision 0), else a READY revision of this concept. */
  activeRevisionId: string | null;
  status: ConceptStatus;
  createdAt: string;
  updatedAt: string;
};

export type ConceptImageDTO = {
  model: string | null;
  provider: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
};

export type RevisionDTO = {
  id: string;
  conceptId: string;
  revisionNumber: number;
  /** The version this one was edited from (null = the original image, revision 0). */
  baseRevisionId: string | null;
  clientFeedback: string;
  /** Claude's interpretation: what changes. */
  interpretationSummary: string[] | null;
  /** Claude's one-line summary of what changes, written for the client. */
  interpretation: string | null;
  /** Claude's interpretation: what must stay unchanged. */
  preserved: string[] | null;
  /** The prompt the image model received for this revision. */
  generationPrompt: string | null;
  imageUrl: string | null;
  /** Client-safe reason a refinement failed. */
  errorReason: string | null;
  /** A failed revision that can be retried now (newest of its concept, base still current). */
  retryable: boolean;
  status: RevisionStatus;
  createdAt: string;
};

export type FinalDesignDTO = {
  id: string;
  approvedConceptId: string;
  approvedRevisionId: string | null;
  /** 0 = the original concept image. */
  approvedRevisionNumber: number;
  conceptNumber: number;
  conceptTitle: string;
  conceptDescription: string;
  /** The canonical master image; never changes once finalized. */
  masterImage: string;
  status: FinalDesignStatus;
  /** Claude's description of the canonical object and the features every view must keep. */
  designSummary: string | null;
  invariants: string[];
  createdAt: string;
  finalizedAt: string | null;
};

export type FinalViewDTO = {
  id: string;
  viewType: ViewType;
  versionNumber: number;
  imageUrl: string | null;
  /** The instruction the image model received for this version. */
  generationPrompt: string | null;
  /** Client-safe reason the view failed (status FAILED). */
  errorReason: string | null;
  driveFileId: string | null;
  status: ViewStatus;
  updatedAt: string;
};

export type DeliveryItemDTO = {
  key: string;
  /** Human label: "MASTER.png", "01_CONCEPTS", … */
  name: string;
  kind: "FOLDER" | "FILE";
  status: "PENDING" | "DONE" | "FAILED";
  error: string | null;
  driveUrl: string | null;
};

export type DeliveryDTO = {
  /** Latest upload run, if any. */
  run: {
    status: "RUNNING" | "COMPLETED" | "FAILED";
    /** "live" = Google Drive; "test" = the local Drive test double (development). */
    mode: "live" | "test";
    startedAt: string;
    finishedAt: string | null;
    errorReason: string | null;
  } | null;
  folder: { name: string; driveFileId: string; url: string | null } | null;
  /** Approved-design files and project.json, in package order. */
  items: DeliveryItemDTO[];
  done: number;
  total: number;
};

export type FinalViewsDTO = {
  finalDesign: FinalDesignDTO | null;
  views: FinalViewDTO[];
  delivery: DeliveryDTO;
};

export type ProjectEventDTO = {
  id: number;
  eventType: ProjectEventType;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ApiError = { error: { code: string; message: string } };
