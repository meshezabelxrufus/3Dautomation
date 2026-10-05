import { cn } from "@/lib/cn";

/**
 * Stand-in visual for a concept that exists as structured design direction but has no
 * image yet. Reads as a drafting sheet, not a broken image.
 */
export function ConceptSheet({
  number,
  shapeLanguage,
  size = "card",
}: {
  number: number;
  shapeLanguage: string | null;
  size?: "card" | "detail";
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
      <span className="relative inline-flex w-fit items-center gap-1.5 rounded-full border border-hairline bg-surface px-2.5 py-1 text-caption text-ink-3">
        <span className="size-1.5 rounded-full bg-ink-3/60" aria-hidden="true" />
        Image pending
      </span>
    </div>
  );
}
