import { cn } from "@/lib/cn";
import { Spinner } from "@/components/ui/spinner";
import { RelativeTime } from "./relative-time";

type GenerationStatusProps = {
  title: string;
  description?: string;
  /** When the current step started (ISO). Shown as "Started 2 minutes ago". */
  startedAt?: string;
  /** e.g. "2 of 4 ready" */
  progressLabel?: string;
  /** 0–1. Omit for indeterminate work. */
  progress?: number;
  variant?: "banner" | "overlay";
  className?: string;
};

/**
 * Communicates long-running backend work. AI steps are asynchronous and can take
 * minutes, so this always says what is happening and that the page updates itself.
 */
export function GenerationStatus({
  title,
  description,
  startedAt,
  progressLabel,
  progress,
  variant = "banner",
  className,
}: GenerationStatusProps) {
  if (variant === "overlay") {
    return (
      <div
        className={cn(
          "absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface/55 text-ink backdrop-blur-sm",
          className,
        )}
        role="status"
        aria-live="polite"
      >
        <Spinner className="text-[1.25rem] text-ink-2" />
        <span className="text-caption font-medium text-ink-2">{title}</span>
      </div>
    );
  }
  return (
    <div
      className={cn("flex flex-col gap-4 rounded-[var(--radius-card)] border border-hairline bg-surface p-5 sm:p-6", className)}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-4">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
          <Spinner />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-headline text-ink">{title}</p>
          {description ? <p className="text-callout text-ink-2">{description}</p> : null}
          <p className="text-caption text-ink-3">
            {startedAt ? <RelativeTime iso={startedAt} prefix="Started" /> : null}
            {startedAt ? " · " : null}
            This page updates on its own. You can leave and come back.
          </p>
        </div>
        {progressLabel ? <span className="shrink-0 text-callout font-medium text-ink-2">{progressLabel}</span> : null}
      </div>
      {progress !== undefined ? (
        <div className="h-1 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
            style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
