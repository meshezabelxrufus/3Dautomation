"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { RelativeTime } from "./relative-time";

/** The client's original brief, always one glance away. Long briefs collapse. */
export function BriefCard({ brief, createdAt }: { brief: string; createdAt: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = brief.length > 280;
  return (
    <section aria-labelledby="brief-heading" className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-hairline bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="brief-heading" className="text-eyebrow text-ink-3">
          Design brief
        </h2>
        <RelativeTime iso={createdAt} className="text-caption text-ink-3" />
      </div>
      <p className={cn("whitespace-pre-line text-callout text-ink", long && !expanded && "line-clamp-6")}>{brief}</p>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-fit text-caption font-medium text-accent hover:underline"
          aria-expanded={expanded}
        >
          {expanded ? "Show less" : "Show full brief"}
        </button>
      ) : null}
    </section>
  );
}
