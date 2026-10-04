"use client";

import { CircleCheck, X } from "lucide-react";
import { MotionConfig } from "motion/react";
import { useSearchParams } from "next/navigation";
import { useCallback } from "react";
import {
  approveViewAction,
  approveViewsAndDeliverAction,
  finalizeDesignAction,
  generateIdeasAction,
  refineConceptAction,
  regenerateViewAction,
  rejectConceptAction,
  retryProjectAction,
  selectConceptAction,
} from "@/app/projects/actions";
import { useProjectWorkspace, type WorkspaceSnapshot } from "@/lib/api/hooks";
import { statusMeta, workspaceStateFor } from "@/lib/workflow-ui";
import type { ViewType } from "@/server/domain/workflow-states";
import { BriefCard } from "./brief-card";
import { ConceptDetail } from "./concept-detail";
import { ErrorState } from "./error-state";
import { useWorkspaceActions } from "./use-workspace-actions";
import { WorkspaceHeader } from "./workspace-header";
import {
  CompletedStage,
  ConceptsStage,
  EmptyStage,
  FailedStage,
  FinalizingStage,
  GeneratingStage,
  ViewsStage,
} from "./workspace-stages";

/**
 * The project workspace. All UI state is derived from the polled database state;
 * actions only request transitions and then refetch.
 */
export function ProjectWorkspace({ initial }: { initial: WorkspaceSnapshot }) {
  const { project, status, concepts, revisions, finalViews, pollError } = useProjectWorkspace(initial);
  const { run, isRunning, isPending, notice, dismissNotice } = useWorkspaceActions(project.id);
  const searchParams = useSearchParams();
  const focusedId = searchParams.get("concept");
  const focused = focusedId ? concepts.find((c) => c.id === focusedId) ?? null : null;

  // URL-addressable focus: Back closes the detail view; links can be shared.
  const openConcept = useCallback((id: string) => {
    window.history.pushState(null, "", `?concept=${encodeURIComponent(id)}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  const closeConcept = useCallback(() => window.history.pushState(null, "", window.location.pathname), []);

  // Prefer the freshest of the two (status polls more often than the project query refetches).
  const live = { ...project, status: status.status, failureReason: status.failureReason };
  const state = workspaceStateFor(live.status);
  const busy = statusMeta(live.status).busy || isPending;
  const startedAt = status.updatedAt;
  const ideaCount = project.requestedConceptCount ?? 3;

  const conceptStages = state === "generating" || state === "concepts-ready" || state === "refining" || state === "error";

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex flex-col gap-10">
        <WorkspaceHeader project={live} />

        <div aria-live="polite" className="empty:hidden">
          {notice?.tone === "error" ? (
            <ErrorState
              variant="inline"
              title="That didn't work"
              message={notice.message}
              actions={
                <button type="button" onClick={dismissNotice} className="text-ink-3 hover:text-ink" aria-label="Dismiss">
                  <X className="size-4" />
                </button>
              }
            />
          ) : notice?.tone === "success" ? (
            <p className="inline-flex items-center gap-2 text-callout text-success">
              <CircleCheck className="size-4" aria-hidden="true" />
              {notice.message}
            </p>
          ) : null}
          {pollError ? (
            <p className="text-caption text-ink-3">Connection hiccup: showing the last known state and retrying.</p>
          ) : null}
        </div>

        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
          <main className="min-w-0">
            {focused && conceptStages ? (
              <ConceptDetail
                key={focused.id}
                concept={focused}
                revisions={revisions}
                projectStatus={live.status}
                onBack={closeConcept}
                busy={busy}
                isRunning={isRunning}
                onSelect={() => run("select", () => selectConceptAction(project.id, focused.id), "Concept shortlisted.")}
                onReject={() => run("reject", () => rejectConceptAction(project.id, focused.id))}
                onRefine={(feedback) =>
                  run("refine", () => refineConceptAction(project.id, focused.id, feedback), "Refinement requested.")
                }
                onFinalize={async (revisionId) => {
                  const ok = await run("finalize", () => finalizeDesignAction(project.id, focused.id, revisionId));
                  if (ok) closeConcept();
                  return ok;
                }}
              />
            ) : state === "empty" ? (
              <EmptyStage
                pending={isRunning("generate")}
                onGenerate={() => void run("generate", () => generateIdeasAction(project.id, ideaCount))}
              />
            ) : state === "generating" ? (
              <GeneratingStage project={live} concepts={concepts} revisions={revisions} startedAt={startedAt} onOpen={openConcept} />
            ) : state === "concepts-ready" || state === "refining" ? (
              <ConceptsStage
                project={live}
                concepts={concepts}
                revisions={revisions}
                startedAt={startedAt}
                onOpen={openConcept}
                pendingMore={isRunning("generate")}
                onGenerateMore={() => void run("generate", () => generateIdeasAction(project.id, ideaCount))}
              />
            ) : state === "finalizing" ? (
              <FinalizingStage finalViews={finalViews} startedAt={startedAt} />
            ) : state === "generating-views" || state === "view-review" || state === "uploading" ? (
              <ViewsStage
                project={live}
                finalViews={finalViews}
                startedAt={startedAt}
                isRunning={isRunning}
                actions={{
                  approveView: (viewId: string) => run(`approve-${viewId}`, () => approveViewAction(project.id, viewId)),
                  regenerateView: (viewType: ViewType) =>
                    run(`regenerate-${viewType}`, () => regenerateViewAction(project.id, viewType)),
                  deliver: () => run("deliver", () => approveViewsAndDeliverAction(project.id)),
                }}
              />
            ) : state === "completed" ? (
              <CompletedStage project={live} finalViews={finalViews} />
            ) : (
              <FailedStage
                project={live}
                concepts={concepts}
                revisions={revisions}
                finalViews={finalViews}
                onOpen={openConcept}
                pending={isRunning("retry")}
                onRetry={() => void run("retry", () => retryProjectAction(project.id))}
              />
            )}
          </main>

          <aside className="flex flex-col gap-5 lg:sticky lg:top-24 lg:self-start">
            <BriefCard brief={project.designBrief} createdAt={project.createdAt} />
          </aside>
        </div>
      </div>
    </MotionConfig>
  );
}
