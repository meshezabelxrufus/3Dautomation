import { cn } from "@/lib/cn";

/** Placeholder block that shimmers while content loads (static under reduced motion). */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("shimmer rounded-xl", className)} />;
}
