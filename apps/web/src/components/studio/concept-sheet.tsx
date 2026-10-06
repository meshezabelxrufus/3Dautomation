import { cn } from "@/lib/cn";
import { Spinner } from "@/components/ui/spinner";

const NOTES = {
  pending: "Image pending",
  rendering: "Rendering image",
  failed: "Image failed",
} as const;

/**
 * Stand-in visual for a concept that exists as structured design direction but has no
 * image yet (or its image failed). Reads as a drafting sheet, not a broken image.
 */
export function ConceptSheet({
  number,
  shapeLanguage,
  size = "card",
  note = "pending",
}: {
  number: number;
  shapeLanguage: string | null;
  size?: "card" | "detail";
  note?: keyof typeof NOTES;
}) {
  return (
    <div
      className="relative flex h-full w-full flex-col justify-between overflow-hidden bg-surface-2 p-5 sm:p-6"
      style={{
        backgroundImage:
          "linear-gradient(var(--hairline) 1px, transparent 1px), linear-gradient(90deg, var(--hairline) 1px, transparent 1px)",
        backgroundSize: size === "detail" ? "32px 32px" : "24px 24px",
        backgroundPosition: "-1px -1px",
      }}
    >
      <span className="text-eyebrow text-ink-3">Concept sheet</span>
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -bottom-6 right-2 select-none font-semibold leading-none tracking-[-0.06em] text-ink/[0.06] tabular-nums",
          size === "detail" ? "text-[14rem]" : "text-[9rem]",
        )}
      >
        {String(number).padStart(2, "0")}
      </span>
      {shapeLanguage ? (
        <p className={cn("relative max-w-[24ch] text-ink-2 text-balance", size === "detail" ? "text-title" : "text-headline")}>
          {shapeLanguage}
        </p>
      ) : null}
      {note === "rendering" ? (
        <span aria-hidden="true" className="absolute inset-0 animate-pulse bg-accent/[0.05] motion-reduce:animate-none" />
      ) : null}
      <span
        role={note === "rendering" ? "status" : undefined}
        className={cn(
          "relative inline-flex w-fit items-center gap-1.5 rounded-full border bg-surface px-2.5 py-1 text-caption",
          note === "failed" ? "border-danger/30 text-danger" : "border-hairline text-ink-3",
        )}
      >
        {note === "rendering" ? (
          <Spinner className="text-[0.7rem]" />
        ) : (
          <span className={cn("size-1.5 rounded-full", note === "failed" ? "bg-danger" : "bg-ink-3/60")} aria-hidden="true" />
        )}
        {NOTES[note]}
      </span>
    </div>
  );
}
