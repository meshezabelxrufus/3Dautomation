"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ConceptDTO, RevisionDTO } from "@/lib/api/types";
import { ConceptCardSkeleton } from "./loading-state";
import { ConceptCard } from "./concept-card";

/** Latest good image for a concept: newest READY/SELECTED revision, else the original render. */
export function displayImageFor(concept: ConceptDTO, revisions: RevisionDTO[]): string | null {
  const good = revisions
    .filter((r) => r.conceptId === concept.id && r.imageUrl && (r.status === "READY" || r.status === "SELECTED"))
    .sort((a, b) => b.revisionNumber - a.revisionNumber);
  return good[0]?.imageUrl ?? concept.imageUrl;
}

type ConceptGalleryProps = {
  concepts: ConceptDTO[];
  revisions: RevisionDTO[];
  /** While generating, reserve placeholders for ideas that haven't arrived yet. */
  placeholders?: number;
  onOpen?: (conceptId: string) => void;
};

const enter = { type: "spring", bounce: 0, duration: 0.45 } as const;

export function ConceptGallery({ concepts, revisions, placeholders = 0, onOpen }: ConceptGalleryProps) {
  return (
    <ul className="grid gap-5 sm:grid-cols-2 2xl:grid-cols-3" aria-label="Concepts">
      <AnimatePresence initial={false}>
        {concepts.map((concept, i) => (
          <motion.li
            key={concept.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={enter}
          >
            <ConceptCard
              concept={concept}
              imageUrl={displayImageFor(concept, revisions)}
              revisionCount={revisions.filter((r) => r.conceptId === concept.id).length}
              onOpen={onOpen}
              priority={i < 3}
            />
          </motion.li>
        ))}
      </AnimatePresence>
      {Array.from({ length: placeholders }, (_, i) => (
        <li key={`placeholder-${i}`}>
          <ConceptCardSkeleton />
        </li>
      ))}
    </ul>
  );
}
