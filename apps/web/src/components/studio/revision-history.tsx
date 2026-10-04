"use client";

import type { ConceptDTO, RevisionDTO } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { DesignImage } from "@/components/ui/design-image";
import { Spinner } from "@/components/ui/spinner";
import { RelativeTime } from "./relative-time";

export const ORIGINAL = "original";

type RevisionHistoryProps = {
  concept: ConceptDTO;
  revisions: RevisionDTO[];
  /** Currently previewed entry: ORIGINAL or a revision id. */
  activeId: string;
  onSelect: (id: string) => void;
};

/** Newest first, the original concept last. Each entry shows the feedback and how it was interpreted. */
export function RevisionHistory({ concept, revisions, activeId, onSelect }: RevisionHistoryProps) {
  const ordered = [...revisions].sort((a, b) => b.revisionNumber - a.revisionNumber);
  return (
    <section aria-labelledby="revision-history" className="flex flex-col gap-3">
      <h3 id="revision-history" className="text-eyebrow text-ink-3">
        History
      </h3>
      <ol className="flex flex-col gap-2">
        {ordered.map((r) => (
          <li key={r.id}>
            <Entry
              active={activeId === r.id}
              disabled={!r.imageUrl}
              onClick={() => onSelect(r.id)}
              image={r.imageUrl}
              title={`Revision ${r.revisionNumber}`}
              meta={<RelativeTime iso={r.createdAt} />}
              status={r.status}
            >
              <p className="line-clamp-2 text-callout text-ink-2">“{r.clientFeedback}”</p>
              {r.interpretationSummary?.length ? (
                <ul className="mt-1 flex flex-col gap-0.5 text-caption text-ink-3">
                  {r.interpretationSummary.slice(0, 3).map((line) => (
                    <li key={line}>· {line}</li>
                  ))}
                </ul>
              ) : null}
            </Entry>
          </li>
        ))}
        <li>
          <Entry
            active={activeId === ORIGINAL}
            onClick={() => onSelect(ORIGINAL)}
            image={concept.imageUrl}
            title="Original concept"
            meta={<RelativeTime iso={concept.createdAt} />}
          />
        </li>
      </ol>
    </section>
  );
}

function Entry({
  active,
  disabled,
  onClick,
  image,
  title,
  meta,
  status,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  image: string | null;
  title: string;
  meta: React.ReactNode;
  status?: RevisionDTO["status"];
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "pressable flex w-full items-start gap-3 rounded-2xl border p-2.5 text-left",
        active ? "border-accent/50 bg-accent-soft" : "border-hairline bg-surface hover:border-hairline-strong",
      )}
    >
      <DesignImage src={image} alt="" className="w-16 shrink-0 rounded-xl" sizes="4rem" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-callout font-medium text-ink">{title}</span>
          <span className="shrink-0 text-caption text-ink-3">
            {status === "GENERATING" ? (
              <span className="inline-flex items-center gap-1.5 text-accent">
                <Spinner /> Working
              </span>
            ) : status === "FAILED" ? (
              <span className="text-danger">Failed</span>
            ) : status === "SELECTED" ? (
              <span className="text-success">Approved</span>
            ) : (
              meta
            )}
          </span>
        </div>
        {children}
      </div>
    </button>
  );
}
