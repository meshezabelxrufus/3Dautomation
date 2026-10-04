"use client";

import { Check, History } from "lucide-react";
import type { ConceptDTO } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { DesignImage } from "@/components/ui/design-image";
import { GenerationStatus } from "./generation-status";

const BADGES: Partial<Record<ConceptDTO["status"], { label: string; className: string }>> = {
  SELECTED: { label: "Selected", className: "bg-accent text-accent-ink" },
  REJECTED: { label: "Rejected", className: "bg-surface/90 text-ink-2" },
  FINAL: { label: "Final", className: "bg-success text-white" },
  FAILED: { label: "Couldn't generate", className: "bg-danger text-white" },
};

type ConceptCardProps = {
  concept: ConceptDTO;
  /** Image to show (latest good revision, else the concept image). */
  imageUrl: string | null;
  revisionCount: number;
  onOpen?: (conceptId: string) => void;
  priority?: boolean;
};

/** A design direction: large render first, then title and a short description. */
export function ConceptCard({ concept, imageUrl, revisionCount, onOpen, priority }: ConceptCardProps) {
  const badge = BADGES[concept.status];
  const working = concept.status === "GENERATING" || concept.status === "REFINING";
  const interactive = Boolean(onOpen) && concept.status !== "GENERATING" && concept.status !== "FAILED";
  const content = (
    <>
      <DesignImage
        src={imageUrl}
        alt={`Concept ${concept.conceptNumber}: ${concept.title}`}
        priority={priority}
        className={cn(concept.status === "REJECTED" && "opacity-50 grayscale-[35%]")}
      >
        {working ? (
          <GenerationStatus variant="overlay" title={concept.status === "REFINING" ? "Refining…" : "Generating…"} />
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
      <div className="flex flex-col gap-1.5 px-2 text-left">
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
      </div>
    </>
  );

  const shell = cn(
    "flex w-full flex-col gap-4 rounded-[var(--radius-card)] border bg-surface p-3 pb-5",
    concept.status === "SELECTED" ? "border-accent/40 ring-1 ring-accent/30" : "border-hairline",
  );

  return interactive ? (
    <button type="button" onClick={() => onOpen?.(concept.id)} className={cn(shell, "pressable hover:border-hairline-strong")}>
      {content}
    </button>
  ) : (
    <div className={shell}>{content}</div>
  );
}
