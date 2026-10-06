"use client";

import { CircleCheck, X } from "lucide-react";
import { MotionConfig } from "motion/react";
import { useSearchParams } from "next/navigation";
import { useCallback } from "react";
import {
  approveViewsAndDeliverAction,
  deliverToDriveAction,
  finalizeDesignAction,
  generateViewsAction,
  generateIdeasAction,
  refineConceptAction,
  regenerateViewAction,
  rejectConceptAction,
  restoreConceptAction,
  retryConceptImageAction,
  retryProjectAction,
  retryRefinementAction,
  chooseConceptVersionAction,
  selectConceptAction,
} from "@/app/projects/actions";
import { useProjectWorkspace, type WorkspaceSnapshot } from "@/lib/api/hooks";
import { statusMeta, workspaceStateFor } from "@/lib/workflow-ui";
import type { ViewType } from "@/server/domain/workflow-states";
import { BriefCard } from "./brief-card";
import type { ConceptCardActions } from "./concept-card";
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
  const refineIntent = searchParams.get("refine") === "1";

  // URL-addressable focus: Back closes the detail view; links can be shared.
  const openConcept = useCallback((id: string, intent?: "refine") => {
    window.history.pushState(null, "", `?concept=${encodeURIComponent(id)}${intent === "refine" ? "&refine=1" : ""}`);
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
  // The gallery gets the full width; the brief moves above it.
  const galleryView = !focused && (state === "generating" || state === "concepts-ready" || state === "refining");

  const cardActions: ConceptCardActions = {
    reviewing: live.status === "CONCEPT_REVIEW",
    disabled: isPending,
    isRunning,
    approve: (id) => void run(`approve-${id}`, () => selectConceptAction(project.id, id)),
    reject: (id) => void run(`reject-${id}`, () => rejectConceptAction(project.id, id)),
    restore: (id) => void run(`restore-${id}`, () => restoreConceptAction(project.id, id)),
    refine: (id) => openConcept(id, "refine"),
    retryImage: (id) => void run(`retry-image-${id}`, () => retryConceptImageAction(project.id, id)),
  };

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

        {galleryView ? <BriefCard brief={project.designBrief} createdAt={project.createdAt} compact /> : null}

        <div className={galleryView ? "" : "grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]"}>
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
                autoFocusRefine={refineIntent}
                onUseVersion={(revisionId) =>
                  run("use-version", () => chooseConceptVersionAction(project.id, focused.id, revisionId), "Version approved.")
                }
                onUnapprove={() => run("restore", () => restoreConceptAction(project.id, focused.id))}
                onReject={() => run("reject", () => rejectConceptAction(project.id, focused.id))}
                onRestore={() => run("restore", () => restoreConceptAction(project.id, focused.id))}
                onRetryImage={() => run("retry-image", () => retryConceptImageAction(project.id, focused.id))}
                onRefine={(baseRevisionId, feedback) =>
                  run("refine", () => refineConceptAction(project.id, focused.id, baseRevisionId, feedback), "Refinement started.")
                }
                onRetryRefinement={(revisionId) =>
                  run(`retry-refine-${revisionId}`, () => retryRefinementAction(project.id, focused.id, revisionId), "Retrying the refinement.")
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
              <GeneratingStage
                project={live}
                concepts={concepts}
                revisions={revisions}
                startedAt={startedAt}
                onOpen={openConcept}
                actions={cardActions}
              />
            ) : state === "concepts-ready" || state === "refining" ? (
              <ConceptsStage
                project={live}
                concepts={concepts}
                revisions={revisions}
                startedAt={startedAt}
                onOpen={openConcept}
                pendingMore={isRunning("generate")}
                actions={cardActions}
                onGenerateMore={() => void run("generate", () => generateIdeasAction(project.id, ideaCount))}
              />
            ) : state === "finalizing" ? (
              <FinalizingStage
                finalViews={finalViews}
                startedAt={startedAt}
                pending={isRunning("start-views")}
                onStartViews={() => void run("start-views", () => generateViewsAction(project.id))}
              />
            ) : state === "generating-views" || state === "view-review" || state === "uploading" ? (
              <ViewsStage
                project={live}
                finalViews={finalViews}
                startedAt={startedAt}
                isRunning={isRunning}
                busy={isPending}
                actions={{
                  regenerateView: (viewType: ViewType) =>
                    run(`regenerate-${viewType}`, () => regenerateViewAction(project.id, viewType)),
                  retryFailedViews: () => run("retry-views", () => generateViewsAction(project.id)),
                  approveAll: () => run("approve-all", () => approveViewsAndDeliverAction(project.id)),
                  deliver: () => run("deliver", () => deliverToDriveAction(project.id)),
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

          {galleryView ? null : (
            <aside className="flex flex-col gap-5 lg:sticky lg:top-24 lg:self-start">
              <BriefCard brief={project.designBrief} createdAt={project.createdAt} />
            </aside>
          )}
        </div>
      </div>
    </MotionConfig>
  );
}
