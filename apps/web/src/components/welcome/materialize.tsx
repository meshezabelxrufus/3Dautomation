import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Glass arrives as a material, not a fade: blur, scale and opacity resolve together.
 * Pure CSS so content never depends on JavaScript to become visible; under reduced
 * motion the global rule makes it instant.
 */
export function Materialize({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <div className={cn("animate-materialize", className)} style={{ animationDelay: `${delay}s` }}>
      {children}
    </div>
  );
}
