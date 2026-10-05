"use client";

import { ArrowLeft, Check, X } from "lucide-react";
import { useState } from "react";
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
  onSelect: () => Promise<boolean>;
  onReject: () => Promise<boolean>;
  onRefine: (feedback: string) => Promise<boolean>;
  onFinalize: (revisionId: string | null) => Promise<boolean>;
  isRunning: (key: string) => boolean;
  busy: boolean;
};

/** One concept up close: large render, details, decisions, refinement and history. */
export function ConceptDetail({
  concept,
  revisions,
  projectStatus,
  onBack,
  onSelect,
  onReject,
  onRefine,
  onFinalize,
  isRunning,
  busy,
}: ConceptDetailProps) {
  const own = revisions.filter((r) => r.conceptId === concept.id);
  const latestGood = [...own]
    .filter((r) => r.imageUrl && (r.status === "READY" || r.status === "SELECTED"))
    .sort((a, b) => b.revisionNumber - a.revisionNumber)[0];
  const [activeId, setActiveId] = useState<string>(latestGood?.id ?? ORIGINAL);
  const [confirming, setConfirming] = useState(false);
  // When a new revision lands while this panel is open, show it.
  const [seenLatest, setSeenLatest] = useState(latestGood?.id);
  if (latestGood?.id !== seenLatest) {
    setSeenLatest(latestGood?.id);
    if (latestGood) setActiveId(latestGood.id);
  }

  const active = activeId === ORIGINAL ? null : own.find((r) => r.id === activeId) ?? null;
  const previewImage = active?.imageUrl ?? concept.imageUrl;
  const previewLabel = active ? `Revision ${active.revisionNumber}` : "Original concept";
  const reviewing = projectStatus === "CONCEPT_REVIEW";
  const refining = concept.status === "REFINING";
  const decidable = reviewing && (concept.status === "READY" || concept.status === "SELECTED");
  const finalizableRevision = active && (active.status === "READY" || active.status === "SELECTED") ? active : null;

  return (
    <article className="flex flex-col gap-6">
      <Button variant="ghost" size="sm" onClick={onBack} icon={<ArrowLeft className="size-4" />} className="-ml-2 self-start">
        All concepts
      </Button>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3 lg:sticky lg:top-24 lg:self-start">
          <DesignImage
            src={previewImage}
            alt={`${concept.title}, ${previewLabel.toLowerCase()}`}
            sizes="(min-width: 1024px) 55vw, 100vw"
            priority
            placeholder={<ConceptSheet number={concept.conceptNumber} shapeLanguage={concept.shapeLanguage} size="detail" />}
          >
            {refining ? <GenerationStatus variant="overlay" title="Applying your feedback…" /> : null}
          </DesignImage>
          <p className="text-caption text-ink-3">
            {previewImage ? `Showing: ${previewLabel}` : "Images are generated from these concept details in the next step."}
          </p>
        </div>

        <div className="flex flex-col gap-7">
          <header className="flex flex-col gap-3">
            <p className="text-eyebrow text-ink-3">Concept {String(concept.conceptNumber).padStart(2, "0")}</p>
            <h2 className="text-title text-ink">{concept.title}</h2>
            <p className="text-body text-ink-2">{concept.description}</p>
          </header>

          <dl className="flex flex-col gap-4 border-t border-hairline pt-5">
            <TextItem label="Creative direction" value={concept.creativeDirection} />
            <TextItem label="Shape language" value={concept.shapeLanguage} />
            <TextItem label="Visual characteristics" value={concept.visualCharacteristics} />
            <TagList label="Key features" items={concept.keyFeatures} />
            <TagList label="Materials" items={concept.materials} />
          </dl>

          {concept.generationPrompt ? (
            <details className="group rounded-2xl border border-hairline bg-surface-2 px-4 py-3">
              <summary className="cursor-pointer select-none text-callout font-medium text-ink-2 marker:text-ink-3">
                Image-generation prompt
              </summary>
              <p className="mt-2 font-mono text-caption leading-relaxed text-ink-2">{concept.generationPrompt}</p>
            </details>
          ) : null}

          {decidable ? (
            <div className="flex flex-col gap-3 border-t border-hairline pt-5">
              <Button
                size="lg"
                onClick={() => setConfirming(true)}
                disabled={busy || !previewImage}
                icon={<Check className="size-4" />}
              >
                Approve as final design
              </Button>
              {!previewImage ? (
                <p className="text-caption text-ink-3">Final approval unlocks once this concept has an image.</p>
              ) : null}
              <div className="flex gap-2">
                {concept.status !== "SELECTED" ? (
                  <Button variant="secondary" className="flex-1" onClick={onSelect} loading={isRunning("select")} disabled={busy}>
                    Shortlist
                  </Button>
                ) : null}
                <Button
                  variant="danger"
                  className="flex-1"
                  onClick={onReject}
                  loading={isRunning("reject")}
                  disabled={busy}
                  icon={<X className="size-4" />}
                >
                  Reject
                </Button>
              </div>
            </div>
          ) : null}

          {concept.status === "READY" || concept.status === "SELECTED" || refining ? (
            <div className="border-t border-hairline pt-5">
              <RefinementInput
                onSubmit={onRefine}
                pending={isRunning("refine")}
                disabledReason={
                  refining
                    ? "A refinement is in progress. You can send another once it's done."
                    : !reviewing
                      ? "Refinements are available while reviewing concepts."
                      : !previewImage
                        ? "Refinements become available once concept images are generated."
                        : null
                }
              />
            </div>
          ) : null}

          <RevisionHistory concept={concept} revisions={own} activeId={activeId} onSelect={setActiveId} />
        </div>
      </div>

      <ApprovalDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Approve as the final design?"
        description={
          <>
            <strong className="font-medium text-ink">{concept.title}</strong> ({previewLabel.toLowerCase()}) becomes the master
            design. Front, back, left and right views are generated from it next. Other concepts stay in the project history.
          </>
        }
        previewImage={finalizableRevision?.imageUrl ?? concept.imageUrl}
        previewAlt={`${concept.title} final design`}
        confirmLabel="Approve design"
        pending={isRunning("finalize")}
        onConfirm={async () => {
          if (await onFinalize(finalizableRevision?.id ?? null)) setConfirming(false);
        }}
      />
    </article>
  );
}

function TextItem({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-eyebrow text-ink-3">{label}</dt>
      <dd className="text-callout text-ink">{value}</dd>
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
            <li key={item} className="rounded-full border border-hairline bg-surface-2 px-3 py-1 text-caption text-ink-2">
              {item}
            </li>
          ))}
        </ul>
      </dd>
    </div>
  );
}
