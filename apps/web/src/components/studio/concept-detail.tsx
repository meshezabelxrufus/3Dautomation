"use client";

import { ArrowLeft, Check, ChevronRight, PenLine, RotateCcw, TriangleAlert, Undo2, X } from "lucide-react";
import { useRef, useState } from "react";
import type { ConceptDTO, RevisionDTO } from "@/lib/api/types";
import type { ProjectStatus } from "@/server/domain/workflow-states";
import { Button } from "@/components/ui/button";
import { DesignImage } from "@/components/ui/design-image";
import { ApprovalDialog } from "./approval-dialog";
import { ConceptSheet } from "./concept-sheet";
import { GenerationStatus } from "./generation-status";
import { RefinementInput } from "./refinement-input";
import { ORIGINAL, RevisionHistory } from "./revision-history";

type ConceptDetailProps = {
  concept: ConceptDTO;
  revisions: RevisionDTO[];
  projectStatus: ProjectStatus;
  onBack: () => void;
  /** "Use this version": make it current and approve the concept (null = original). */
  onUseVersion: (revisionId: string | null) => Promise<boolean>;
  onUnapprove: () => Promise<boolean>;
  onReject: () => Promise<boolean>;
  onRestore: () => Promise<boolean>;
  onRetryImage: () => Promise<boolean>;
  /** Refine the current version; baseRevisionId is the version the client is looking at. */
  onRefine: (baseRevisionId: string | null, feedback: string) => Promise<boolean>;
  onRetryRefinement: (revisionId: string) => Promise<boolean>;
  onFinalize: (revisionId: string | null) => Promise<boolean>;
  isRunning: (key: string) => boolean;
  busy: boolean;
  /** Opened from a card's Refine button: focus the feedback field. */
  autoFocusRefine?: boolean;
};

const label = (n: number) => (n === 0 ? "Revision 0 (original)" : `Revision ${n}`);

/**
 * One concept up close: the current version large, its description, the full revision history and
 * the refinement input. Older versions can be viewed; "Use this version" makes one current again.
 */
export function ConceptDetail(props: ConceptDetailProps) {
  const { concept, revisions, projectStatus, onBack, isRunning, busy } = props;
  const own = revisions.filter((r) => r.conceptId === concept.id);
  const currentId = concept.activeRevisionId ?? ORIGINAL;
  const [viewingId, setViewingId] = useState<string>(currentId);
  const [confirming, setConfirming] = useState(false);
  const refineRef = useRef<HTMLTextAreaElement>(null);

  // When the current version changes (a refinement landed, or another version was chosen), show it.
  const [seenCurrent, setSeenCurrent] = useState(currentId);
  if (seenCurrent !== currentId) {
    setSeenCurrent(currentId);
    setViewingId(currentId);
  }

  const viewedRevision = viewingId === ORIGINAL ? null : own.find((r) => r.id === viewingId) ?? null;
  const viewedNumber = viewedRevision?.revisionNumber ?? 0;
  const currentRevision = concept.activeRevisionId ? own.find((r) => r.id === concept.activeRevisionId) ?? null : null;
  const currentNumber = currentRevision?.revisionNumber ?? 0;
  const viewedImage = viewedRevision ? viewedRevision.imageUrl : concept.imageUrl;
  const viewingCurrent = viewingId === currentId;
  const pending = own.find((r) => r.status === "GENERATING");

  const reviewing = projectStatus === "CONCEPT_REVIEW";
  const refining = concept.status === "REFINING";
  const decidable = reviewing && (concept.status === "READY" || concept.status === "SELECTED");
  const approvedHere = concept.status === "SELECTED" && viewingCurrent;
  const viewedVersionId = viewedRevision?.id ?? null;

  const continueRefining = () => {
    setViewingId(currentId);
    requestAnimationFrame(() => {
      refineRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      refineRef.current?.focus({ preventScroll: true });
    });
  };

  return (
    <article className="flex flex-col gap-6" aria-label={`Concept ${concept.conceptNumber}: ${concept.title}`}>
      <Button variant="ghost" size="sm" onClick={onBack} icon={<ArrowLeft className="size-4" />} className="-ml-2 self-start">
        All concepts
      </Button>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        {/* ------------------------------------------------ the version being viewed */}
        <div className="flex flex-col gap-3 lg:sticky lg:top-24 lg:self-start">
          <DesignImage
            src={viewedImage}
            alt={`${concept.title}, ${label(viewedNumber).toLowerCase()}`}
            sizes="(min-width: 1024px) 55vw, 100vw"
            priority
            placeholder={
              <ConceptSheet
                number={concept.conceptNumber}
                shapeLanguage={concept.shapeLanguage}
                size="detail"
                note={concept.status === "FAILED" ? "failed" : concept.status === "GENERATING" ? "rendering" : "pending"}
              />
            }
          >
            {refining && viewingCurrent ? (
              <GenerationStatus
                variant="overlay"
                title={pending ? `Creating revision ${pending.revisionNumber}…` : "Applying your feedback…"}
              />
            ) : null}
          </DesignImage>

          {concept.status === "FAILED" ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-danger-soft/60 p-3">
              <p className="flex items-start gap-2 text-callout text-ink-2" role="status">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                {concept.imageError ?? "The image couldn't be generated."}
              </p>
              <Button
                size="sm"
                variant="secondary"
                onClick={props.onRetryImage}
                loading={isRunning("retry-image")}
                disabled={busy}
                icon={<RotateCcw className="size-3.5" />}
              >
                Retry image
              </Button>
            </div>
          ) : viewingCurrent ? (
            <p className="text-caption text-ink-3">
              {viewedImage
                ? `${label(viewedNumber)} · current version${concept.status === "SELECTED" ? " · approved" : ""}`
                : concept.status === "GENERATING"
                  ? "The image is being rendered from these concept details. This page updates on its own."
                  : "This concept has no image yet."}
            </p>
          ) : (
            <div className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface-2 p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-callout text-ink-2">
                Viewing <strong className="font-medium text-ink">{label(viewedNumber)}</strong>, an older version. The current
                version is {label(currentNumber).toLowerCase()}.
              </p>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="ghost" onClick={() => setViewingId(currentId)}>
                  Back to current
                </Button>
                {decidable && !refining && viewedImage ? (
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} disabled={busy}>
                    Finalize this version…
                  </Button>
                ) : null}
                {decidable && !refining ? (
                  <Button
                    size="sm"
                    onClick={() => props.onUseVersion(viewedVersionId)}
                    loading={isRunning("use-version")}
                    disabled={busy}
                    icon={<Check className="size-3.5" />}
                  >
                    Use this version
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </div>

        {/* ------------------------------------------------ description, decisions, refinement, history */}
        <div className="flex flex-col gap-7">
          <header className="flex flex-col gap-3">
            <p className="text-eyebrow text-ink-3">Concept {String(concept.conceptNumber).padStart(2, "0")}</p>
            <h2 className="text-title text-ink">{concept.title}</h2>
            <p className="text-body text-ink-2">{concept.description}</p>
          </header>

          {decidable && viewingCurrent && viewedImage && !refining ? (
            <div className="flex flex-col gap-3 border-t border-hairline pt-5">
              <p className="text-callout text-ink-2">
                {approvedHere
                  ? `You approved ${label(currentNumber).toLowerCase()}. Finalize it as the design, or keep refining.`
                  : `${label(currentNumber)} is the current candidate.`}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {approvedHere ? (
                  <Button size="lg" onClick={() => setConfirming(true)} disabled={busy} icon={<Check className="size-4" />}>
                    Finalize design…
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    onClick={() => props.onUseVersion(concept.activeRevisionId)}
                    loading={isRunning("use-version")}
                    disabled={busy}
                    icon={<Check className="size-4" />}
                  >
                    Use this version
                  </Button>
                )}
                <Button size="lg" variant="secondary" onClick={continueRefining} disabled={busy} icon={<PenLine className="size-4" />}>
                  Continue refining
                </Button>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {approvedHere ? (
                  <button
                    type="button"
                    onClick={props.onUnapprove}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 text-caption font-medium text-ink-2 hover:text-ink disabled:opacity-50"
                  >
                    <Undo2 className="size-3.5" aria-hidden="true" /> Undo approval
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirming(true)}
                    disabled={busy}
                    className="text-caption font-medium text-ink-2 hover:text-ink disabled:opacity-50"
                  >
                    Finalize this version…
                  </button>
                )}
                <button
                  type="button"
                  onClick={props.onReject}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 text-caption font-medium text-danger hover:underline disabled:opacity-50"
                >
                  <X className="size-3.5" aria-hidden="true" /> Reject concept
                </button>
              </div>
            </div>
          ) : null}

          {reviewing && concept.status === "REJECTED" ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-5">
              <p className="text-callout text-ink-2">Rejected. It stays in the project history and can be restored.</p>
              <Button variant="secondary" onClick={props.onRestore} loading={isRunning("restore")} disabled={busy} icon={<Undo2 className="size-4" />}>
                Restore
              </Button>
            </div>
          ) : null}

          {concept.status === "READY" || concept.status === "SELECTED" || refining ? (
            <div className="border-t border-hairline pt-5">
              <RefinementInput
                key={concept.activeRevisionId ?? ORIGINAL}
                textareaRef={refineRef}
                label="What would you like to change?"
                hint={
                  viewedImage
                    ? `Changes apply to ${label(currentNumber).toLowerCase()} and create revision ${own.length ? Math.max(...own.map((r) => r.revisionNumber)) + 1 : 1}. Everything you don't mention stays the same.`
                    : undefined
                }
                autoFocus={props.autoFocusRefine && !refining && reviewing && Boolean(viewedImage) && viewingCurrent}
                onSubmit={(feedback) => props.onRefine(concept.activeRevisionId, feedback)}
                pending={isRunning("refine")}
                disabledReason={
                  refining
                    ? "A refinement is in progress. You can send the next change once it's done."
                    : !reviewing
                      ? projectStatus === "REFINING"
                        ? "Another concept is being refined. You can refine this one once it's done."
                        : "Refinements are available while reviewing concepts."
                      : !viewedImage && viewingCurrent
                        ? "Refinements become available once this concept has an image."
                        : !viewingCurrent
                          ? `You're viewing an older version. Choose "Use this version" to refine it, or go back to the current version.`
                          : null
                }
              />
            </div>
          ) : null}

          <RevisionHistory
            concept={concept}
            revisions={own}
            viewingId={viewingId}
            onView={setViewingId}
            onRetry={(id) => void props.onRetryRefinement(id)}
            isRetrying={(id) => isRunning(`retry-refine-${id}`)}
            busy={busy || !reviewing}
          />

          <details className="group rounded-2xl border border-hairline bg-surface-2 px-4 py-3">
            <summary className="flex cursor-pointer select-none list-none items-center gap-1.5 text-callout font-medium text-ink-2">
              <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />
              Design details
            </summary>
            <dl className="mt-3 flex flex-col gap-4">
              <TextItem label="Creative direction" value={concept.creativeDirection} />
              <TextItem label="Shape language" value={concept.shapeLanguage} />
              <TextItem label="Visual characteristics" value={concept.visualCharacteristics} />
              <TagList label="Key features" items={concept.keyFeatures} />
              <TagList label="Materials" items={concept.materials} />
              <TextItem label="Original image prompt" value={concept.generationPrompt} mono />
            </dl>
          </details>
        </div>
      </div>

      <ApprovalDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Finalize this design?"
        description={
          <>
            This exact version becomes the <strong className="font-medium text-ink">canonical design</strong>. It won&apos;t
            change afterwards: the front, back, left and right views are generated from it next. Other concepts and versions
            stay in the project history.
          </>
        }
        previewImage={viewedImage}
        previewAlt={`${concept.title}, ${label(viewedNumber).toLowerCase()}`}
        confirmLabel="Finalize design"
        pending={isRunning("finalize")}
        onConfirm={async () => {
          if (await props.onFinalize(viewedVersionId)) setConfirming(false);
        }}
      >
        <dl className="flex flex-col gap-3 rounded-2xl border border-hairline bg-surface-2 p-4 text-callout">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <dt className="sr-only">Concept</dt>
            <dd className="font-medium text-ink">
              Concept {String(concept.conceptNumber).padStart(2, "0")} · {concept.title}
            </dd>
            <dt className="sr-only">Version</dt>
            <dd className="rounded-full bg-accent px-2.5 py-0.5 text-caption font-medium text-accent-ink">{label(viewedNumber)}</dd>
          </div>
          <div>
            <dt className="sr-only">Design description</dt>
            <dd className="text-ink-2">{concept.description}</dd>
          </div>
          {viewedRevision?.interpretation ? (
            <div className="flex flex-col gap-0.5">
              <dt className="text-eyebrow text-ink-3">Latest change in this version</dt>
              <dd className="text-ink-2">{viewedRevision.interpretation}</dd>
            </div>
          ) : null}
        </dl>
      </ApprovalDialog>
    </article>
  );
}

function TextItem({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-eyebrow text-ink-3">{label}</dt>
      <dd className={mono ? "font-mono text-caption leading-relaxed text-ink-2" : "text-callout text-ink"}>{value}</dd>
    </div>
  );
}

function TagList({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <dt className="text-eyebrow text-ink-3">{label}</dt>
      <dd>
        <ul className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <li key={item} className="rounded-full border border-hairline bg-surface px-3 py-1 text-caption text-ink-2">
              {item}
            </li>
          ))}
        </ul>
      </dd>
    </div>
  );
}
