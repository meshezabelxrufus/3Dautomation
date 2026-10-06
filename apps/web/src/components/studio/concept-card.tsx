"use client";

import { Check, History, PenLine, RotateCcw, TriangleAlert, Undo2, X } from "lucide-react";
import type { ConceptDTO } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { DesignImage } from "@/components/ui/design-image";
import { ConceptSheet } from "./concept-sheet";
import { GenerationStatus } from "./generation-status";

const BADGES: Partial<Record<ConceptDTO["status"], { label: string; className: string }>> = {
  SELECTED: { label: "Approved", className: "bg-accent text-accent-ink" },
  REJECTED: { label: "Rejected", className: "bg-surface/90 text-ink-2" },
  FINAL: { label: "Final", className: "bg-success text-white" },
};

/** Decisions available from the gallery. Keys passed to isRunning: `<action>-<conceptId>`. */
export type ConceptCardActions = {
  /** Approve/reject/restore/refine need the project in review; image retry does not. */
  reviewing: boolean;
  disabled: boolean;
  isRunning: (key: string) => boolean;
  approve: (conceptId: string) => void;
  reject: (conceptId: string) => void;
  restore: (conceptId: string) => void;
  refine: (conceptId: string) => void;
  retryImage: (conceptId: string) => void;
};

type ConceptCardProps = {
  concept: ConceptDTO;
  /** Image to show (latest good revision, else the concept image). */
  imageUrl: string | null;
  revisionCount: number;
  onOpen?: (conceptId: string) => void;
  actions?: ConceptCardActions;
  priority?: boolean;
  sizes?: string;
};

/** A design direction: large render first, then title, description, key features and decisions. */
export function ConceptCard({ concept, imageUrl, revisionCount, onOpen, actions, priority, sizes }: ConceptCardProps) {
  const badge = BADGES[concept.status];
  const generating = concept.status === "GENERATING";
  const refining = concept.status === "REFINING";
  const failed = concept.status === "FAILED";
  const rejected = concept.status === "REJECTED";
  const features = concept.keyFeatures.slice(0, 3);
  const moreFeatures = concept.keyFeatures.length - features.length;

  const body = (
    <>
      <DesignImage
        src={imageUrl}
        alt={`Concept ${concept.conceptNumber}: ${concept.title}`}
        priority={priority}
        sizes={sizes}
        className={cn("transition-[opacity,filter] duration-300", rejected && "opacity-45 grayscale-[60%]")}
        placeholder={
          <ConceptSheet
            number={concept.conceptNumber}
            shapeLanguage={concept.shapeLanguage}
            note={failed ? "failed" : generating ? "rendering" : "pending"}
          />
        }
      >
        {refining ? (
          <GenerationStatus variant="overlay" title="Applying feedback…" />
        ) : null}
        {badge ? (
          <span
            className={cn(
              "absolute left-3 top-3 inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-caption font-medium shadow-sm",
              badge.className,
            )}
          >
            {concept.status === "SELECTED" || concept.status === "FINAL" ? <Check className="size-3.5" strokeWidth={2.5} /> : null}
            {badge.label}
          </span>
        ) : null}
      </DesignImage>
      <div className={cn("flex flex-col gap-2 px-2 text-left", rejected && "opacity-60")}>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="min-w-0 truncate text-headline text-ink">
            <span className="mr-2 font-normal text-ink-3 tabular-nums">{String(concept.conceptNumber).padStart(2, "0")}</span>
            {concept.title}
          </h3>
          {revisionCount > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-caption text-ink-3" title={`${revisionCount} revisions`}>
              <History className="size-3.5" aria-hidden="true" />
              {revisionCount}
              <span className="sr-only">revisions</span>
            </span>
          ) : null}
        </div>
        <p className="line-clamp-2 text-callout text-ink-2">{concept.description}</p>
        {features.length ? (
          <ul className="flex flex-wrap gap-1.5 pt-0.5" aria-label="Key features">
            {features.map((f) => (
              <li key={f} className="max-w-full truncate rounded-full bg-sunken px-2.5 py-0.5 text-caption text-ink-2">
                {f}
              </li>
            ))}
            {moreFeatures > 0 ? <li className="px-1 py-0.5 text-caption text-ink-3">+{moreFeatures}</li> : null}
          </ul>
        ) : null}
      </div>
    </>
  );

  const shell = cn(
    "flex h-full w-full flex-col gap-4 rounded-[var(--radius-card)] border bg-surface p-3",
    concept.status === "SELECTED" ? "border-accent/40 ring-1 ring-accent/30" : failed ? "border-danger/30" : "border-hairline",
  );
  // Rendering concepts still open (their full direction is readable while the image is made).
  const openable = Boolean(onOpen);

  return (
    <article className={shell} aria-label={`Concept ${concept.conceptNumber}: ${concept.title}`}>
      {openable ? (
        <button
          type="button"
          onClick={() => onOpen?.(concept.id)}
          className="pressable flex flex-col gap-4 rounded-[calc(var(--radius-card)-0.5rem)] text-left outline-offset-4"
        >
          {body}
        </button>
      ) : (
        <div className="flex flex-col gap-4">{body}</div>
      )}
      {actions ? <CardFooter concept={concept} hasImage={Boolean(imageUrl)} actions={actions} /> : <div className="pb-2" />}
    </article>
  );
}

function CardFooter({ concept, hasImage, actions }: { concept: ConceptDTO; hasImage: boolean; actions: ConceptCardActions }) {
  const { reviewing, disabled, isRunning } = actions;
  const id = concept.id;

  if (concept.status === "FAILED") {
    return (
      <div className="mt-auto flex flex-col gap-3 rounded-2xl bg-danger-soft/60 p-3">
        <p className="flex items-start gap-2 text-caption text-ink-2" role="status">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-danger" aria-hidden="true" />
          {concept.imageError ?? "The image couldn't be generated."}
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          onClick={() => actions.retryImage(id)}
          loading={isRunning(`retry-image-${id}`)}
          disabled={disabled}
          icon={<RotateCcw className="size-3.5" />}
        >
          Retry image
        </Button>
      </div>
    );
  }

  if (concept.status === "REJECTED") {
    return (
      <div className="mt-auto flex items-center justify-between gap-3 px-2 pb-1">
        <span className="text-caption text-ink-3">Kept in history</span>
        {reviewing ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => actions.restore(id)}
            loading={isRunning(`restore-${id}`)}
            disabled={disabled}
            icon={<Undo2 className="size-3.5" />}
          >
            Restore
          </Button>
        ) : null}
      </div>
    );
  }

  if (concept.status !== "READY" && concept.status !== "SELECTED") return <div className="pb-2" />;

  const selected = concept.status === "SELECTED";
  const locked = disabled || !reviewing;
  return (
    <div className="mt-auto grid grid-cols-3 gap-1.5" role="group" aria-label={`Decide on ${concept.title}`}>
      <Button
        size="sm"
        variant={selected ? "primary" : "secondary"}
        onClick={() => (selected ? actions.restore(id) : actions.approve(id))}
        loading={isRunning(`approve-${id}`) || isRunning(`restore-${id}`)}
        disabled={locked}
        aria-pressed={selected}
        title={selected ? "Approved. Click to undo." : "Approve this concept"}
        icon={<Check className="size-3.5" strokeWidth={2.5} />}
        className="px-2"
      >
        {selected ? "Approved" : "Approve"}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => actions.refine(id)}
        disabled={locked || !hasImage}
        title={hasImage ? "Describe changes to this concept" : "Available once the image is ready"}
        icon={<PenLine className="size-3.5" />}
        className="px-2"
      >
        Refine
      </Button>
      <Button
        size="sm"
        variant="danger"
        onClick={() => actions.reject(id)}
        loading={isRunning(`reject-${id}`)}
        disabled={locked}
        title="Reject (kept in history, can be restored)"
        icon={<X className="size-3.5" />}
        className="px-2"
      >
        Reject
      </Button>
    </div>
  );
}
