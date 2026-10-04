"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { statusMeta } from "@/lib/workflow-ui";
import { api } from "./client";
import { queryKeys } from "./query-keys";
import type { ConceptDTO, FinalViewsDTO, ProjectDTO, ProjectStatusDTO, ProjectSummaryDTO, RevisionDTO } from "./types";

/** Poll fast while the backend works, slowly otherwise. Paused in background tabs (TanStack default). */
export const POLL_BUSY_MS = 2_500;
export const POLL_IDLE_MS = 20_000;

export type WorkspaceSnapshot = {
  project: ProjectDTO;
  status: ProjectStatusDTO;
  concepts: ConceptDTO[];
  revisions: RevisionDTO[];
  finalViews: FinalViewsDTO;
};

export function useProjects(initial: ProjectSummaryDTO[]) {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: ({ signal }) => api.listProjects(signal),
    initialData: initial,
    refetchInterval: (q) => (q.state.data?.some((p) => statusMeta(p.status).busy) ? POLL_BUSY_MS * 2 : POLL_IDLE_MS),
  });
}

/**
 * Live workspace data. Only `/status` is polled; the heavier reads refetch when its
 * changeToken changes. Server-rendered data seeds the first render (no loading flash).
 */
export function useProjectWorkspace(initial: WorkspaceSnapshot) {
  const id = initial.project.id;
  const status = useQuery({
    queryKey: queryKeys.status(id),
    queryFn: ({ signal }) => api.getProjectStatus(id, signal),
    initialData: initial.status,
    refetchInterval: (q) => (q.state.data?.isBusy ? POLL_BUSY_MS : POLL_IDLE_MS),
  });
  const token = status.data.changeToken;
  const seeded = token === initial.status.changeToken;
  const detail = { placeholderData: keepPreviousData, staleTime: Infinity } as const;

  const project = useQuery({
    queryKey: queryKeys.detail(id, "project", token),
    queryFn: ({ signal }) => api.getProject(id, signal),
    initialData: seeded ? initial.project : undefined,
    ...detail,
  });
  const concepts = useQuery({
    queryKey: queryKeys.detail(id, "concepts", token),
    queryFn: ({ signal }) => api.getConcepts(id, signal),
    initialData: seeded ? initial.concepts : undefined,
    ...detail,
  });
  const revisions = useQuery({
    queryKey: queryKeys.detail(id, "revisions", token),
    queryFn: ({ signal }) => api.getRevisions(id, signal),
    initialData: seeded ? initial.revisions : undefined,
    ...detail,
  });
  const finalViews = useQuery({
    queryKey: queryKeys.detail(id, "views", token),
    queryFn: ({ signal }) => api.getFinalViews(id, signal),
    initialData: seeded ? initial.finalViews : undefined,
    ...detail,
  });

  return {
    status: status.data,
    project: project.data ?? initial.project,
    concepts: concepts.data ?? initial.concepts,
    revisions: revisions.data ?? initial.revisions,
    finalViews: finalViews.data ?? initial.finalViews,
    /** True while a refetch triggered by a status change is in flight. */
    isSyncing: project.isFetching || concepts.isFetching || revisions.isFetching || finalViews.isFetching,
    pollError: status.error,
  };
}

/** Call after a mutation so the workspace reflects it immediately instead of on the next poll. */
export function useRefreshWorkspace(projectId: string) {
  const qc = useQueryClient();
  return useCallback(async () => {
    await qc.invalidateQueries({ queryKey: queryKeys.project(projectId) });
    await qc.invalidateQueries({ queryKey: queryKeys.projects });
  }, [qc, projectId]);
}
