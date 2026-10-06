"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ConceptDTO, RevisionDTO } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { ConceptCardSkeleton } from "./loading-state";
import { ConceptCard, type ConceptCardActions } from "./concept-card";

/** The concept's current version: its active revision, else the original render (revision 0). */
export function displayImageFor(concept: ConceptDTO, revisions: RevisionDTO[]): string | null {
  const active = concept.activeRevisionId ? revisions.find((r) => r.id === concept.activeRevisionId) : null;
  return active?.imageUrl ?? concept.imageUrl;
}

/**
 * Grid for 2–5 concepts (and more after "More ideas"). Two and four read as balanced pairs;
 * five becomes a row of three over a row of two wider cards instead of leaving a hole.
 */
export function galleryLayout(count: number): { grid: string; item: (index: number) => string; sizes: (index: number) => string } {
  const half = "(min-width: 640px) 50vw, 100vw";
  const third = "(min-width: 1280px) 33vw, (min-width: 640px) 50vw, 100vw";
  if (count <= 2 || count === 4) return { grid: "sm:grid-cols-2", item: () => "", sizes: () => half };
  if (count === 5) {
    return {
      grid: "sm:grid-cols-2 xl:grid-cols-6",
      item: (i) => (i < 3 ? "xl:col-span-2" : "xl:col-span-3"),
      sizes: (i) => (i < 3 ? third : half),
    };
  }
  return { grid: "sm:grid-cols-2 xl:grid-cols-3", item: () => "", sizes: () => third };
}

type ConceptGalleryProps = {
  concepts: ConceptDTO[];
  revisions: RevisionDTO[];
  /** While generating, reserve placeholders for ideas that haven't arrived yet. */
  placeholders?: number;
  onOpen?: (conceptId: string) => void;
  actions?: ConceptCardActions;
};

const enter = { type: "spring", bounce: 0, duration: 0.45 } as const;

export function ConceptGallery({ concepts, revisions, placeholders = 0, onOpen, actions }: ConceptGalleryProps) {
  const layout = galleryLayout(concepts.length + placeholders);
  return (
    <ul className={cn("grid gap-5", layout.grid)} aria-label="Concepts">
      <AnimatePresence initial={false}>
        {concepts.map((concept, i) => (
          <motion.li
            key={concept.id}
            layout="position"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={enter}
            className={layout.item(i)}
          >
            <ConceptCard
              concept={concept}
              imageUrl={displayImageFor(concept, revisions)}
              revisionCount={revisions.filter((r) => r.conceptId === concept.id).length}
              onOpen={onOpen}
              actions={actions}
              priority={i < 3}
              sizes={layout.sizes(i)}
            />
          </motion.li>
        ))}
      </AnimatePresence>
      {Array.from({ length: placeholders }, (_, i) => (
        <li key={`placeholder-${i}`} className={layout.item(concepts.length + i)}>
          <ConceptCardSkeleton />
        </li>
      ))}
    </ul>
  );
}
