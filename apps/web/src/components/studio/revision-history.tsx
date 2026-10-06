"use client";

import { ChevronRight, RotateCcw } from "lucide-react";
import type { ConceptDTO, RevisionDTO } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { DesignImage } from "@/components/ui/design-image";
import { Spinner } from "@/components/ui/spinner";
import { RelativeTime } from "./relative-time";

/** Id used for revision 0, the original concept image. */
export const ORIGINAL = "original";

type RevisionHistoryProps = {
  concept: ConceptDTO;
  revisions: RevisionDTO[];
  /** Entry being previewed: ORIGINAL or a revision id. */
  viewingId: string;
  onView: (id: string) => void;
  onRetry?: (revisionId: string) => void;
  isRetrying?: (revisionId: string) => boolean;
  busy?: boolean;
};

/**
 * Every version of the concept in order: revision 0 (the original) first, then each refinement.
 * Nothing is ever overwritten; the current version is marked, older ones can be viewed.
 */
export function RevisionHistory({ concept, revisions, viewingId, onView, onRetry, isRetrying, busy }: RevisionHistoryProps) {
  const ordered = [...revisions].sort((a, b) => a.revisionNumber - b.revisionNumber);
  const numberOf = new Map(ordered.map((r) => [r.id, r.revisionNumber]));
  const currentId = concept.activeRevisionId ?? ORIGINAL;

  return (
    <section aria-labelledby="revision-history" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="revision-history" className="text-eyebrow text-ink-3">
          Revision history
        </h3>
        <span className="text-caption text-ink-3">
          {ordered.length + 1} {ordered.length === 0 ? "version" : "versions"}
        </span>
      </div>
      <ol className="flex flex-col gap-2">
        <li>
          <Entry
            viewing={viewingId === ORIGINAL}
            current={currentId === ORIGINAL}
            onView={() => onView(ORIGINAL)}
            image={concept.imageUrl}
            title="Revision 0"
            subtitle="Original concept"
            time={concept.createdAt}
          />
        </li>
        {ordered.map((r) => {
          const parent = r.baseRevisionId ? numberOf.get(r.baseRevisionId) ?? null : 0;
          const branched = parent !== r.revisionNumber - 1 && r.revisionNumber > 1;
          return (
            <li key={r.id}>
              <Entry
                viewing={viewingId === r.id}
                current={currentId === r.id}
                disabled={!r.imageUrl}
                onView={() => onView(r.id)}
                image={r.imageUrl}
                title={`Revision ${r.revisionNumber}`}
                subtitle={branched ? `Edited from revision ${parent}` : undefined}
                time={r.createdAt}
                status={r.status}
              >
                <p className="line-clamp-3 text-callout text-ink-2">“{r.clientFeedback}”</p>
                {r.status === "FAILED" ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <p className="text-caption text-danger">{r.errorReason ?? "This refinement didn't finish."}</p>
                    {r.retryable && onRetry ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 px-2.5"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRetry(r.id);
                        }}
                        loading={isRetrying?.(r.id)}
                        disabled={busy}
                        icon={<RotateCcw className="size-3.5" />}
                      >
                        Retry
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {r.interpretation ? <p className="mt-1 text-caption text-ink-3">{r.interpretation}</p> : null}
                {r.interpretationSummary?.length || r.preserved?.length || r.generationPrompt ? (
                  <details className="group mt-1.5" onClick={(e) => e.stopPropagation()}>
                    <summary className="inline-flex cursor-pointer select-none list-none items-center gap-1 text-caption font-medium text-ink-2 hover:text-ink">
                      <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
                      How it was interpreted
                    </summary>
                    <div className="mt-2 flex flex-col gap-2 text-caption">
                      <InterpretationList label="Changed" items={r.interpretationSummary} tone="change" />
                      <InterpretationList label="Kept unchanged" items={r.preserved} tone="keep" />
                      {r.generationPrompt ? (
                        <div className="flex flex-col gap-1">
                          <span className="text-eyebrow text-ink-3">Image prompt</span>
                          <p className="rounded-xl bg-sunken px-3 py-2 font-mono leading-relaxed text-ink-2">{r.generationPrompt}</p>
                        </div>
                      ) : null}
                    </div>
                  </details>
                ) : null}
              </Entry>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function InterpretationList({ label, items, tone }: { label: string; items: string[] | null; tone: "change" | "keep" }) {
  if (!items?.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-eyebrow text-ink-3">{label}</span>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-ink-2">
            <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", tone === "change" ? "bg-accent" : "bg-ink-3/50")} aria-hidden="true" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Entry({
  viewing,
  current,
  disabled,
  onView,
  image,
  title,
  subtitle,
  time,
  status,
  children,
}: {
  viewing: boolean;
  current: boolean;
  disabled?: boolean;
  onView: () => void;
  image: string | null;
  title: string;
  subtitle?: string;
  time: string;
  status?: RevisionDTO["status"];
  children?: React.ReactNode;
}) {
  // A div with button semantics: entries contain their own controls (Retry, details).
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={viewing}
      aria-disabled={disabled || undefined}
      aria-label={`${title}${current ? ", current version" : ""}${viewing ? ", shown" : ""}`}
      onClick={() => !disabled && onView()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onView();
        }
      }}
      className={cn(
        "pressable flex w-full items-start gap-3 rounded-2xl border p-2.5 text-left outline-offset-2",
        viewing ? "border-accent/50 bg-accent-soft" : "border-hairline bg-surface",
        disabled ? "cursor-default" : "cursor-pointer hover:border-hairline-strong",
      )}
    >
      <DesignImage src={image} alt="" className="w-16 shrink-0 rounded-xl" sizes="4rem" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-callout font-medium text-ink tabular-nums">{title}</span>
            {current ? (
              <span className="rounded-full bg-accent px-2 py-px text-[0.6875rem] font-medium text-accent-ink">Current</span>
            ) : null}
          </span>
          <span className="shrink-0 text-caption text-ink-3">
            {status === "GENERATING" ? (
              <span className="inline-flex items-center gap-1.5 text-accent">
                <Spinner /> Working
              </span>
            ) : status === "FAILED" ? (
              <span className="text-danger">Failed</span>
            ) : (
              <RelativeTime iso={time} />
            )}
          </span>
        </div>
        {subtitle ? <span className="text-caption text-ink-3">{subtitle}</span> : null}
        {children}
      </div>
    </div>
  );
}
