"use client";

import { Check, Plus, RotateCcw, Sparkles } from "lucide-react";
import { useState } from "react";
import type { ConceptDTO, FinalViewsDTO, ProjectDTO, RevisionDTO } from "@/lib/api/types";
import { STATUS_META } from "@/lib/workflow-ui";
import type { ViewType } from "@/server/domain/workflow-states";
import { Button } from "@/components/ui/button";
import { DesignImage } from "@/components/ui/design-image";
import { ApprovalDialog } from "./approval-dialog";
import type { ConceptCardActions } from "./concept-card";
import { ConceptGallery } from "./concept-gallery";
import { DeliveryList, DeliveryProgress, DriveFolderReference } from "./delivery";
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
  actions,
}: {
  project: ProjectDTO;
  concepts: ConceptDTO[];
  revisions: RevisionDTO[];
  startedAt: string;
  onOpen: (id: string) => void;
  actions: ConceptCardActions;
}) {
  const requested = project.requestedConceptCount ?? 3;
  // Concepts of this run arrive together once Claude has written them; each image follows on its own.
  const batch = concepts.filter((c) => c.createdAt >= startedAt);
  const rendered = batch.filter((c) => c.status !== "GENERATING").length;
  const writing = batch.length === 0;
  return (
    <div className="flex flex-col gap-6">
      <GenerationStatus
        title={writing ? "Writing concepts…" : "Rendering concept images…"}
        description={
          writing
            ? STATUS_META.GENERATING_CONCEPTS.description
            : "Each concept gets its own image. They appear one by one; a failed image can be retried without touching the others."
        }
        startedAt={startedAt}
        progressLabel={writing ? `${requested} concepts` : `${rendered} of ${batch.length} images`}
        progress={writing ? undefined : rendered / Math.max(1, batch.length)}
      />
      <ConceptGallery
        concepts={concepts}
        revisions={revisions}
        placeholders={Math.max(0, requested - batch.length)}
        onOpen={onOpen}
        actions={actions}
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
  actions,
}: {
  project: ProjectDTO;
  concepts: ConceptDTO[];
  revisions: RevisionDTO[];
  startedAt: string;
  onOpen: (id: string) => void;
  onGenerateMore: () => void;
  pendingMore: boolean;
  actions: ConceptCardActions;
}) {
  const refining = project.status === "REFINING";
  const count = (status: ConceptDTO["status"]) => concepts.filter((c) => c.status === status).length;
  const approved = count("SELECTED");
  const rejected = count("REJECTED");
  const failed = count("FAILED");
  const summary = [
    `${concepts.length} ${concepts.length === 1 ? "idea" : "ideas"}`,
    approved ? `${approved} approved` : null,
    rejected ? `${rejected} rejected` : null,
    failed ? `${failed} ${failed === 1 ? "image" : "images"} to retry` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex flex-col gap-6">
      {refining ? (
        <GenerationStatus title="Refining" description={STATUS_META.REFINING.description} startedAt={startedAt} />
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-headline text-ink">Concepts</h2>
          <p className="text-callout text-ink-2">
            {summary}. Approve the directions you like, refine one, or open it for its full direction.
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
      <ConceptGallery concepts={concepts} revisions={revisions} onOpen={onOpen} actions={actions} />
    </div>
  );
}

/* ---------------------------------------------------------------- finalizing → views → delivery */

const versionLabel = (n: number) => (n === 0 ? "Revision 0 (original)" : `Revision ${n}`);

/** The canonical design every view is generated from. It never changes after finalizing. */
function MasterDesign({ finalViews, compact }: { finalViews: FinalViewsDTO; compact?: boolean }) {
  const design = finalViews.finalDesign;
  if (!design) return null;
  return (
    <section
      aria-labelledby="final-design-heading"
      className={
        compact
          ? "flex items-start gap-4 rounded-[var(--radius-card)] border border-hairline bg-surface p-4"
          : "flex flex-col gap-4"
      }
    >
      <DesignImage
        src={design.masterImage}
        alt="Canonical master design"
        className={compact ? "w-20 shrink-0 sm:w-40" : "max-w-xl"}
        sizes={compact ? "(min-width: 640px) 10rem, 5rem" : "(min-width: 1024px) 36rem, 100vw"}
        priority
      />
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="text-eyebrow text-ink-3">Canonical design</p>
        <h2 id="final-design-heading" className="text-headline text-ink">
          {String(design.conceptNumber).padStart(2, "0")} · {design.conceptTitle}
        </h2>
        <p className="text-caption text-ink-3">
          {versionLabel(design.approvedRevisionNumber)} · finalized. The master design never changes; every view is generated from it.
        </p>
        {design.designSummary ? <p className="text-callout text-ink-2">{design.designSummary}</p> : null}
        {design.invariants.length ? (
          <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Kept identical in every view">
            {design.invariants.map((item) => (
              <li key={item} className="rounded-full bg-sunken px-2.5 py-0.5 text-caption text-ink-2">
                {item}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

export function FinalizingStage({
  finalViews,
  startedAt,
  onStartViews,
  pending,
}: {
  finalViews: FinalViewsDTO;
  startedAt: string;
  onStartViews: () => void;
  pending: boolean;
}) {
  return (
    <div className="flex flex-col gap-6">
      <GenerationStatus title="Design finalized" description={STATUS_META.FINALIZING.description} startedAt={startedAt} />
      <MasterDesign finalViews={finalViews} compact />
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-callout text-ink-2">Views didn&apos;t start after a few seconds?</p>
        <Button variant="secondary" size="sm" onClick={onStartViews} loading={pending} icon={<RotateCcw className="size-3.5" />}>
          Start the four views
        </Button>
      </div>
    </div>
  );
}

export function ViewsStage({
  project,
  finalViews,
  startedAt,
  isRunning,
  busy,
  actions,
}: {
  project: ProjectDTO;
  finalViews: FinalViewsDTO;
  startedAt: string;
  isRunning: (key: string) => boolean;
  busy: boolean;
  actions: {
    regenerateView: (viewType: ViewType) => ReturnType<Run>;
    retryFailedViews: () => ReturnType<Run>;
    approveAll: () => ReturnType<Run>;
    deliver: () => ReturnType<Run>;
  };
}) {
  const [confirming, setConfirming] = useState(false);
  const status = project.status;
  const views = finalViews.views;
  const count = (s: string[]) => views.filter((v) => s.includes(v.status)).length;
  const ready = count(["READY", "APPROVED"]);
  const failed = count(["FAILED"]);
  const running = count(["GENERATING"]) + (4 - views.length);
  const generating = status === "GENERATING_VIEWS";
  const reviewing = status === "VIEW_REVIEW";
  const uploading = status === "UPLOADING_TO_DRIVE";

  return (
    <div className="flex flex-col gap-8">
      {generating && running > 0 ? (
        <GenerationStatus
          title="Generating the four views"
          description={STATUS_META.GENERATING_VIEWS.description}
          startedAt={startedAt}
          progressLabel={`${ready} of 4 ready`}
          progress={ready / 4}
        />
      ) : null}
      {generating && running === 0 && failed > 0 ? (
        <ErrorState
          variant="inline"
          title={failed === 1 ? "1 of the 4 views couldn't be generated" : `${failed} of the 4 views couldn't be generated`}
          message="The successful views are kept. Only the failed ones are generated again, from the master design."
          actions={
            <Button size="sm" onClick={() => void actions.retryFailedViews()} loading={isRunning("retry-views")} disabled={busy} icon={<RotateCcw className="size-3.5" />}>
              Retry failed {failed === 1 ? "view" : "views"}
            </Button>
          }
        />
      ) : null}
      {uploading ? (
        <DeliveryProgress
          delivery={finalViews.delivery}
          onRetry={() => void actions.deliver()}
          pending={isRunning("deliver")}
          busy={busy}
        />
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
                ? "The same object from each side. Regenerate any view that isn't right, then approve all four."
                : "Front, back, left and right of the canonical design. Only the viewpoint changes."}
            </p>
          </div>
          {reviewing ? (
            <Button size="lg" onClick={() => setConfirming(true)} disabled={ready !== 4 || busy} icon={<Check className="size-4" />}>
              Approve all views
            </Button>
          ) : null}
        </div>
        <FinalViewGrid
          views={views}
          canRegenerate={reviewing}
          canRetry={generating}
          onRegenerate={(type) => void actions.regenerateView(type)}
          isRunning={isRunning}
          disabled={busy}
        />
      </section>

      <ApprovalDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Approve all four views?"
        description="The final design and its front, back, left and right views are approved together and handed over for delivery to Google Drive, where the 3D modelling step picks them up."
        confirmLabel="Approve all views"
        pending={isRunning("approve-all")}
        onConfirm={async () => {
          if (await actions.approveAll()) setConfirming(false);
        }}
      >
        <ul className="flex flex-col gap-1.5 text-callout text-ink-2">
          {["Canonical master design", "Front, back, left and right views", "Design details"].map((item) => (
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
  const design = finalViews.finalDesign;
  const completedAt = finalViews.delivery.run?.finishedAt ?? project.finalizedAt;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-start gap-4 rounded-[var(--radius-card)] border border-success/25 bg-success-soft p-5" role="status">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-success text-white">
          <Check className="size-5" strokeWidth={3} aria-hidden="true" />
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-title text-ink">Design package completed.</h2>
          <p className="text-callout text-ink-2">
            The canonical design, its four views and project.json are in Google Drive, ready for 3D modelling.
          </p>
        </div>
      </div>

      <section aria-labelledby="views-heading" className="flex flex-col gap-4">
        <h2 id="views-heading" className="text-headline text-ink">
          Final four views
        </h2>
        <FinalViewGrid views={finalViews.views} />
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <section aria-labelledby="project-info-heading" className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-hairline bg-surface p-5">
          <h2 id="project-info-heading" className="text-eyebrow text-ink-3">
            Project
          </h2>
          <dl className="grid gap-3 text-callout sm:grid-cols-2">
            <Info label="Project" value={project.projectName} />
            <Info label="Client" value={project.clientName} />
            {design ? (
              <Info
                label="Approved design"
                value={`${String(design.conceptNumber).padStart(2, "0")} · ${design.conceptTitle} · ${versionLabel(design.approvedRevisionNumber)}`}
              />
            ) : null}
            {completedAt ? <Info label="Completed" value={new Date(completedAt).toLocaleString()} /> : null}
          </dl>
          <div className="flex flex-col gap-1">
            <p className="text-eyebrow text-ink-3">Design brief</p>
            <p className="whitespace-pre-line text-callout text-ink-2">{project.designBrief}</p>
          </div>
        </section>
        <div className="flex flex-col gap-4">
          <DriveFolderReference delivery={finalViews.delivery} />
          <DeliveryList items={finalViews.delivery.items} compact />
        </div>
      </div>

      <MasterDesign finalViews={finalViews} compact />
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-caption text-ink-3">{label}</dt>
      <dd className="truncate text-ink">{value}</dd>
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
          <ConceptGallery concepts={concepts} revisions={revisions} onOpen={onOpen} />
        </section>
      ) : null}
    </div>
  );
}
