import { ArrowRight, Plus } from "lucide-react";
import Link from "next/link";
import type { ProjectSummaryDTO } from "@/lib/api/types";
import type { Quote } from "@/lib/quotes";
import { cn } from "@/lib/cn";
import { statusMeta } from "@/lib/workflow-ui";
import { DesignImage } from "@/components/ui/design-image";

/* Everything here sits on the dark studio stage: white-on-glass "vibrancy" text, not theme tokens. */

export function QuoteCard({ quote }: { quote: Quote }) {
  return (
    <figure className="glass relative overflow-hidden rounded-[1.75rem] p-6 sm:p-8">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -top-6 right-5 select-none font-serif text-[9rem] leading-none text-white/[0.07]"
      >
        ”
      </span>
      <figcaption className="mb-4 flex items-center gap-2 text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-white/55">
        <span className="h-px w-6 bg-white/30" aria-hidden="true" />
        Quote of the day
      </figcaption>
      <blockquote className="relative">
        <p className="text-[clamp(1.375rem,1.1rem+1vw,1.875rem)] font-medium leading-[1.2] tracking-[-0.02em] text-white text-balance">
          {quote.text}
        </p>
      </blockquote>
      <p className="mt-4 text-[0.9375rem] font-medium tracking-[0.01em] text-white/60">— {quote.author}</p>
    </figure>
  );
}

const TILE_ACCENT = {
  review: "bg-[#ff9f0a]",
  working: "bg-[#2997ff]",
  done: "bg-[#30d158]",
} as const;

export function StatTile({
  value,
  label,
  tone,
  href,
}: {
  value: number;
  label: string;
  tone: keyof typeof TILE_ACCENT;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="glass-thin pressable group flex min-h-28 flex-col justify-between gap-3 rounded-2xl p-4 hover:bg-white/[0.09] sm:p-5"
    >
      <span className="flex items-start gap-2 text-[0.8125rem] font-medium leading-tight tracking-[0.01em] text-white/65">
        <span className={cn("mt-[0.3rem] size-1.5 shrink-0 rounded-full", TILE_ACCENT[tone])} aria-hidden="true" />
        {label}
      </span>
      <span className="text-[2.25rem] font-semibold leading-none tracking-[-0.03em] text-white tabular-nums">{value}</span>
    </Link>
  );
}

export function ContinueCard({ project }: { project: ProjectSummaryDTO | null }) {
  if (!project) {
    return (
      <Link
        href="/projects/new"
        className="glass pressable group flex h-full items-center justify-between gap-4 rounded-[1.75rem] p-6 hover:bg-white/[0.08]"
      >
        <span className="flex flex-col gap-1">
          <span className="text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-white/55">Your first design</span>
          <span className="text-[1.1875rem] font-semibold tracking-[-0.012em] text-white">Describe an idea to begin</span>
        </span>
        <span className="grid size-10 place-items-center rounded-full bg-white text-black">
          <Plus className="size-4" />
        </span>
      </Link>
    );
  }
  const meta = statusMeta(project.status);
  return (
    <Link
      href={`/projects/${project.id}`}
      className="glass pressable group flex h-full items-center gap-4 rounded-[1.75rem] p-3 pr-5 hover:bg-white/[0.08]"
    >
      <DesignImage
        src={project.coverImageUrl}
        alt=""
        className="w-20 shrink-0 rounded-[1.25rem] sm:w-24"
        sizes="6rem"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[0.75rem] font-semibold uppercase tracking-[0.14em] text-white/55">Pick up where you left off</span>
        <span className="truncate text-[1.1875rem] font-semibold tracking-[-0.012em] text-white">{project.projectName}</span>
        <span className="flex items-center gap-1.5 text-[0.8125rem] text-white/65">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              meta.tone === "working" ? "bg-[#2997ff]" : meta.tone === "attention" ? "bg-[#ff9f0a]" : meta.tone === "danger" ? "bg-[#ff453a]" : "bg-white/50",
            )}
            aria-hidden="true"
          />
          {meta.label}
        </span>
      </span>
      <ArrowRight className="size-5 shrink-0 text-white/50 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-white" />
    </Link>
  );
}
