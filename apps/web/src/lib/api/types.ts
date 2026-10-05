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
  isBusy: boolean;
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
  /** Prompt for the image model, written by Claude (images are generated in a later step). */
  generationPrompt: string | null;
  imageUrl: string | null;
  status: ConceptStatus;
  createdAt: string;
  updatedAt: string;
};

export type RevisionDTO = {
  id: string;
  conceptId: string;
  revisionNumber: number;
  clientFeedback: string;
  /** Human-readable summary of Claude's interpretation, if available. */
  interpretationSummary: string[] | null;
  imageUrl: string | null;
  status: RevisionStatus;
  createdAt: string;
};

export type FinalDesignDTO = {
  id: string;
  approvedConceptId: string;
  approvedRevisionId: string | null;
  masterImage: string;
  status: FinalDesignStatus;
  createdAt: string;
  finalizedAt: string | null;
};

export type FinalViewDTO = {
  id: string;
  viewType: ViewType;
  versionNumber: number;
  imageUrl: string | null;
  driveFileId: string | null;
  status: ViewStatus;
  updatedAt: string;
};

export type FinalViewsDTO = {
  finalDesign: FinalDesignDTO | null;
  views: FinalViewDTO[];
};

export type ProjectEventDTO = {
  id: number;
  eventType: ProjectEventType;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ApiError = { error: { code: string; message: string } };
