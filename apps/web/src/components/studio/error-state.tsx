import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type ErrorStateProps = {
  title: string;
  message?: string | null;
  /** Retry / navigation controls. */
  actions?: ReactNode;
  variant?: "panel" | "inline";
  className?: string;
};

/** Error with a clear next step. "inline" is for action errors inside the workspace. */
export function ErrorState({ title, message, actions, variant = "panel", className }: ErrorStateProps) {
  if (variant === "inline") {
    return (
      <div
        role="alert"
        className={cn(
          "flex items-start gap-3 rounded-2xl border border-danger/25 bg-danger-soft px-4 py-3 text-callout text-ink",
          className,
        )}
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={2} aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="font-medium">{title}</p>
          {message ? <p className="text-ink-2">{message}</p> : null}
        </div>
        {actions}
      </div>
    );
  }
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center gap-4 rounded-[var(--radius-card)] border border-hairline bg-surface px-6 py-14 text-center",
        className,
      )}
    >
      <span className="grid size-12 place-items-center rounded-full bg-danger-soft text-danger">
        <TriangleAlert className="size-5" strokeWidth={2} aria-hidden="true" />
      </span>
      <div className="flex max-w-md flex-col gap-1.5">
        <h2 className="text-headline text-ink">{title}</h2>
        {message ? <p className="text-callout text-ink-2">{message}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap justify-center gap-3">{actions}</div> : null}
    </div>
  );
}
