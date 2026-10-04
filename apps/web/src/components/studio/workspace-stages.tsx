"use client";

import { Check, CloudUpload, Plus, RotateCcw, Sparkles } from "lucide-react";
import { useState } from "react";
import type { ConceptDTO, FinalViewsDTO, ProjectDTO, RevisionDTO } from "@/lib/api/types";
import { STATUS_META } from "@/lib/workflow-ui";
import type { ViewType } from "@/server/domain/workflow-states";
import { Button } from "@/components/ui/button";
import { DesignImage } from "@/components/ui/design-image";
import { ApprovalDialog } from "./approval-dialog";
import { ConceptGallery } from "./concept-gallery";
import { ErrorState } from "./error-state";
import { FinalViewGrid } from "./final-view-grid";
import { GenerationStatus } from "./generation-status";

type Run = (key: string, action: () => Promise<{ ok: true } | { ok: false; message: string }>, success?: string) => Promise<boolean>;

/* ---------------------------------------------------------------- empty (DRAFT) */

export function EmptyStage({ onGenerate, pending }: { onGenerate: () => void; pending: boolean }) {
  return (
    <div className="flex flex-col items-center gap-5 rounded-[var(--radius-card)] border border-dashed border-hairline-strong bg-surface/60 px-6 py-16 text-center">
      <span className="grid size-14 place-items-center rounded-full bg-sunken text-ink-2">
        <Sparkles className="size-6" strokeWidth={1.75} aria-hidden="true" />
      </span>
      <div className="flex max-w-md flex-col gap-2">
        <h2 className="text-headline text-ink">No ideas yet</h2>
        <p className="text-callout text-ink-2">
          Generate a first set of design directions from the brief. Concepts appear here as soon as each one is ready.
        </p>
      </div>
      <Button size="lg" onClick={onGenerate} loading={pending} icon={<Sparkles className="size-4" />}>
        Generate ideas
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------- generating concepts */

export function GeneratingStage({
  project,
  concepts,
  revisions,
  startedAt,
  onOpen,
}: {
  project: ProjectDTO;
  concepts: ConceptDTO[];
  revisions: RevisionDTO[];
  startedAt: string;
  onOpen: (id: string) => void;
}) {
  const requested = project.requestedConceptCount ?? 3;
  const ready = concepts.filter((c) => c.imageUrl).length;
  const total = Math.max(requested, concepts.length);
  return (
    <div className="flex flex-col gap-6">
      <GenerationStatus
        title="Generating ideas"
        description={STATUS_META.GENERATING_CONCEPTS.description}
        startedAt={startedAt}
        progressLabel={`${ready} of ${total} ready`}
        progress={total ? ready / total : undefined}
      />
      <ConceptGallery
        concepts={concepts}
        revisions={revisions}
        placeholders={Math.max(0, requested - concepts.length)}
        onOpen={onOpen}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- concept review / refining */

export function ConceptsStage({
  project,
  concepts,
  revisions,
  startedAt,
  onOpen,
  onGenerateMore,
  pendingMore,
}: {
  project: ProjectDTO;
  concepts: ConceptDTO[];
  revisions: RevisionDTO[];
  startedAt: string;
  onOpen: (id: string) => void;
  onGenerateMore: () => void;
  pendingMore: boolean;
}) {
  const refining = project.status === "REFINING";
  const shortlisted = concepts.filter((c) => c.status === "SELECTED").length;
  const rejected = concepts.filter((c) => c.status === "REJECTED").length;
  const visible = concepts.filter((c) => c.status !== "FAILED");
  return (
    <div className="flex flex-col gap-6">
      {refining ? (
        <GenerationStatus title="Refining" description={STATUS_META.REFINING.description} startedAt={startedAt} />
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-headline text-ink">Concepts</h2>
          <p className="text-callout text-ink-2">
            {visible.length} {visible.length === 1 ? "idea" : "ideas"}
            {shortlisted ? ` · ${shortlisted} shortlisted` : ""}
            {rejected ? ` · ${rejected} rejected` : ""}. Open one to refine or approve it.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={onGenerateMore}
          loading={pendingMore}
          disabled={refining}
          icon={<Plus className="size-4" />}
        >
          More ideas
        </Button>
      </div>
      <ConceptGallery concepts={visible} revisions={revisions} onOpen={onOpen} />
    </div>
  );
}

/* ---------------------------------------------------------------- finalizing → views → delivery */

function MasterDesign({ finalViews, compact }: { finalViews: FinalViewsDTO; compact?: boolean }) {
  const design = finalViews.finalDesign;
  if (!design) return null;
  return (
    <section aria-labelledby="final-design-heading" className={compact ? "flex items-center gap-4" : "flex flex-col gap-3"}>
      <DesignImage
        src={design.masterImage}
        alt="Approved final design"
        className={compact ? "w-24 shrink-0 sm:w-28" : "max-w-xl"}
        sizes={compact ? "7rem" : "(min-width: 1024px) 36rem, 100vw"}
        priority
      />
      <div className="flex flex-col gap-1">
        <h2 id="final-design-heading" className="text-headline text-ink">
          Final design
        </h2>
        <p className="text-callout text-ink-2">
          {design.status === "FINALIZED" ? "Approved master image. Views are generated from it." : "Being locked as the master image."}
        </p>
      </div>
    </section>
  );
}

export function FinalizingStage({ finalViews, startedAt }: { finalViews: FinalViewsDTO; startedAt: string }) {
  return (
    <div className="flex flex-col gap-6">
      <GenerationStatus title="Finalizing the design" description={STATUS_META.FINALIZING.description} startedAt={startedAt} />
      <MasterDesign finalViews={finalViews} />
    </div>
  );
}

export function ViewsStage({
  project,
  finalViews,
  startedAt,
  isRunning,
  actions,
}: {
  project: ProjectDTO;
  finalViews: FinalViewsDTO;
  startedAt: string;
  isRunning: (key: string) => boolean;
  actions: {
    approveView: (viewId: string) => ReturnType<Run>;
    regenerateView: (viewType: ViewType) => ReturnType<Run>;
    deliver: () => ReturnType<Run>;
  };
}) {
  const [confirming, setConfirming] = useState(false);
  const status = project.status;
  const views = finalViews.views;
  const ready = views.filter((v) => v.status === "READY" || v.status === "APPROVED").length;
  const approved = views.filter((v) => v.status === "APPROVED").length;
  const reviewing = status === "VIEW_REVIEW";
  const allGood = ready === 4;

  return (
    <div className="flex flex-col gap-8">
      {status === "GENERATING_VIEWS" ? (
        <GenerationStatus
          title="Generating views"
          description={STATUS_META.GENERATING_VIEWS.description}
          startedAt={startedAt}
          progressLabel={`${ready} of 4 ready`}
          progress={ready / 4}
        />
      ) : null}
      {status === "UPLOADING_TO_DRIVE" ? (
        <GenerationStatus title="Delivering to Google Drive" description={STATUS_META.UPLOADING_TO_DRIVE.description} startedAt={startedAt} />
      ) : null}

      <MasterDesign finalViews={finalViews} compact />

      <section aria-labelledby="views-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 id="views-heading" className="text-headline text-ink">
              Four views
            </h2>
            <p className="text-callout text-ink-2">
              {reviewing
                ? `${approved} of 4 approved. Approve each view or regenerate the ones that aren't right.`
                : "Front, back, left and right, generated from the final design."}
            </p>
          </div>
          {reviewing ? (
            <Button
              size="lg"
              onClick={() => setConfirming(true)}
              disabled={!allGood}
              icon={<CloudUpload className="size-4" />}
            >
              Approve & deliver
            </Button>
          ) : null}
        </div>
        <FinalViewGrid
          views={views}
          reviewing={reviewing}
          onApprove={(id) => void actions.approveView(id)}
          onRegenerate={(type) => void actions.regenerateView(type)}
          isRunning={isRunning}
        />
      </section>

      <ApprovalDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Approve all views and deliver?"
        description="All four views are approved and uploaded with the final design to Google Drive, where the 3D modeling step picks them up. This completes the design phase."
        confirmLabel="Approve & deliver"
        pending={isRunning("deliver")}
        onConfirm={async () => {
          if (await actions.deliver()) setConfirming(false);
        }}
      >
        <ul className="flex flex-col gap-1.5 text-callout text-ink-2">
          {["Final design (master image)", "Front, back, left and right views", "Design details (manifest)"].map((item) => (
            <li key={item} className="flex items-center gap-2">
              <Check className="size-4 text-success" strokeWidth={2.5} aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>
      </ApprovalDialog>
    </div>
  );
}

/* ---------------------------------------------------------------- completed */

export function CompletedStage({ project, finalViews }: { project: ProjectDTO; finalViews: FinalViewsDTO }) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-start gap-4 rounded-[var(--radius-card)] border border-success/25 bg-success-soft p-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-success text-white">
          <Check className="size-4" strokeWidth={3} aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-headline text-ink">Delivered to Google Drive</p>
          <p className="text-callout text-ink-2">
            {project.projectName} is complete. The final design and its four views are ready for 3D modeling.
          </p>
        </div>
      </div>
      <MasterDesign finalViews={finalViews} />
      <FinalViewGrid views={finalViews.views} />
    </div>
  );
}

/* ---------------------------------------------------------------- error (FAILED) */

export function FailedStage({
  project,
  concepts,
  revisions,
  finalViews,
  onRetry,
  pending,
  onOpen,
}: {
  project: ProjectDTO;
  concepts: ConceptDTO[];
  revisions: RevisionDTO[];
  finalViews: FinalViewsDTO;
  onRetry: () => void;
  pending: boolean;
  onOpen: (id: string) => void;
}) {
  const failedStep = project.failedFromStatus ? STATUS_META[project.failedFromStatus].label.toLowerCase() : "the last step";
  return (
    <div className="flex flex-col gap-8">
      <ErrorState
        title={`Something went wrong while ${failedStep}`}
        message={project.failureReason ?? "The step didn't finish. Retrying usually fixes temporary problems."}
        actions={
          <Button size="lg" onClick={onRetry} loading={pending} icon={<RotateCcw className="size-4" />}>
            Retry
          </Button>
        }
      />
      {finalViews.finalDesign ? (
        <>
          <MasterDesign finalViews={finalViews} compact />
          {finalViews.views.length ? <FinalViewGrid views={finalViews.views} /> : null}
        </>
      ) : concepts.some((c) => c.imageUrl) ? (
        <section className="flex flex-col gap-4" aria-label="Existing concepts">
          <h2 className="text-headline text-ink">Concepts so far</h2>
          <ConceptGallery concepts={concepts.filter((c) => c.status !== "FAILED")} revisions={revisions} onOpen={onOpen} />
        </section>
      ) : null}
    </div>
  );
}
