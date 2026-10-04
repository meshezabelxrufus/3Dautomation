/**
 * Typed fetchers for the workflow read API. Used by TanStack Query in the browser.
 * The backing endpoints are Route Handlers under /api/projects. When n8n is wired in,
 * these contracts stay the same; only the server side changes.
 */
import type {
  ApiError,
  ConceptDTO,
  FinalViewsDTO,
  ProjectDTO,
  ProjectStatusDTO,
  ProjectSummaryDTO,
  RevisionDTO,
} from "./types";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, cache: "no-store", headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(res.status, body?.error.code ?? "http_error", body?.error.message ?? res.statusText);
  }
  return (await res.json()) as T;
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

export const api = {
  listProjects: (signal?: AbortSignal) =>
    getJson<{ projects: ProjectSummaryDTO[] }>("/api/projects", signal).then((r) => r.projects),
  getProject: (projectId: string, signal?: AbortSignal) =>
    getJson<{ project: ProjectDTO }>(base(projectId), signal).then((r) => r.project),
  getProjectStatus: (projectId: string, signal?: AbortSignal) =>
    getJson<{ status: ProjectStatusDTO }>(`${base(projectId)}/status`, signal).then((r) => r.status),
  getConcepts: (projectId: string, signal?: AbortSignal) =>
    getJson<{ concepts: ConceptDTO[] }>(`${base(projectId)}/concepts`, signal).then((r) => r.concepts),
  getRevisions: (projectId: string, signal?: AbortSignal) =>
    getJson<{ revisions: RevisionDTO[] }>(`${base(projectId)}/revisions`, signal).then((r) => r.revisions),
  getFinalViews: (projectId: string, signal?: AbortSignal) =>
    getJson<{ finalViews: FinalViewsDTO }>(`${base(projectId)}/views`, signal).then((r) => r.finalViews),
};
