import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export const inputClasses =
  "w-full rounded-2xl border border-hairline-strong bg-surface px-4 text-body text-ink placeholder:text-ink-3 " +
  "transition-[border-color,box-shadow] duration-150 outline-none " +
  "focus:border-accent focus:ring-4 focus:ring-accent-soft " +
  "aria-invalid:border-danger aria-invalid:focus:ring-danger-soft";

type FieldProps = {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  /** Shown at the trailing edge of the label row (e.g. a character counter). */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** Label + control + inline hint/error, wired for screen readers. */
export function Field({ id, label, hint, error, aside, children, className }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-baseline justify-between gap-4">
        <label htmlFor={id} className="text-callout font-medium text-ink">
          {label}
        </label>
        {aside}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-caption text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-caption text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const describedBy = (id: string, error?: string, hint?: unknown) =>
  error ? `${id}-error` : hint ? `${id}-hint` : undefined;
