import type { ProjectStatus as Status } from "@/server/domain/workflow-states";
import { cn } from "@/lib/cn";
import { STAGES, stageFor, statusMeta, type StatusTone } from "@/lib/workflow-ui";

const toneClasses: Record<StatusTone, { pill: string; dot: string }> = {
  neutral: { pill: "bg-sunken text-ink-2", dot: "bg-ink-3" },
  working: { pill: "bg-accent-soft text-accent", dot: "bg-accent" },
  attention: { pill: "bg-attention-soft text-attention", dot: "bg-attention" },
  success: { pill: "bg-success-soft text-success", dot: "bg-success" },
  danger: { pill: "bg-danger-soft text-danger", dot: "bg-danger" },
};

type Props = {
  status: Status;
  failedFrom?: Status | null;
  /** "pill" for lists and headers; "stages" adds the six-stage progress strip. */
  variant?: "pill" | "stages";
  className?: string;
};

/** Project status as a labelled pill and/or a stage strip. Derived only from the database status. */
export function ProjectStatus({ status, failedFrom, variant = "pill", className }: Props) {
  const meta = statusMeta(status);
  const tone = toneClasses[meta.tone];
  const pill = (
    <span
      className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-caption font-medium", tone.pill)}
    >
      <span className="relative flex size-1.5">
        {meta.busy ? (
          <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:hidden", tone.dot)} />
        ) : null}
        <span className={cn("relative size-1.5 rounded-full", tone.dot)} />
      </span>
      {meta.label}
    </span>
  );
  if (variant === "pill") return <span className={className}>{pill}</span>;
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center gap-3">{pill}</div>
      <StageStrip status={status} failedFrom={failedFrom} />
    </div>
  );
}

/** Six segments: done, current, upcoming. Labels appear from the sm breakpoint. */
export function StageStrip({
  status,
  failedFrom,
  compact,
}: {
  status: Status;
  failedFrom?: Status | null;
  compact?: boolean;
}) {
  const current = stageFor(status, failedFrom);
  const completed = status === "COMPLETED";
  const failed = status === "FAILED";
  return (
    <ol
      className="grid grid-cols-6 gap-1.5"
      aria-label={`Stage ${current + 1} of ${STAGES.length}: ${STAGES[current]}`}
    >
      {STAGES.map((stage, i) => {
        const done = completed || i < current;
        const isCurrent = !completed && i === current;
        return (
          <li key={stage} className="flex min-w-0 flex-col gap-1.5" aria-current={isCurrent ? "step" : undefined}>
            <span
              className={cn(
                "h-1 rounded-full transition-colors duration-300",
                done && "bg-ink",
                isCurrent && (failed ? "bg-danger" : "bg-accent"),
                !done && !isCurrent && "bg-hairline-strong",
              )}
            />
            {compact ? null : (
              <span
                className={cn(
                  "hidden truncate text-caption sm:block",
                  isCurrent ? "font-medium text-ink" : done ? "text-ink-2" : "text-ink-3",
                )}
              >
                {stage}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
