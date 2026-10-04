import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton layouts that match the real pages, so content doesn't jump when it arrives. */
export function LoadingState({ variant, label = "Loading" }: { variant: "projects" | "workspace"; label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-8">
      <span className="sr-only">{label}…</span>
      {variant === "projects" ? (
        <>
          <div className="flex flex-col gap-3">
            <Skeleton className="h-10 w-56" />
            <Skeleton className="h-5 w-80 max-w-full" />
          </div>
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-hairline bg-surface p-3 pb-5">
                <Skeleton className="aspect-[4/3] w-full rounded-[var(--radius-image)]" />
                <div className="flex flex-col gap-2 px-2">
                  <Skeleton className="h-5 w-2/3" />
                  <Skeleton className="h-4 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-72 max-w-full" />
            <Skeleton className="h-2 w-full" />
          </div>
          <div className="grid gap-5 sm:grid-cols-2 2xl:grid-cols-3">
            {Array.from({ length: 2 }, (_, i) => (
              <ConceptCardSkeleton key={i} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ConceptCardSkeleton() {
  return (
    <div className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-hairline bg-surface p-3 pb-5" aria-hidden="true">
      <Skeleton className="aspect-square w-full rounded-[var(--radius-image)]" />
      <div className="flex flex-col gap-2 px-2">
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    </div>
  );
}
