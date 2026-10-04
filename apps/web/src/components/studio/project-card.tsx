import Link from "next/link";
import type { ProjectSummaryDTO } from "@/lib/api/types";
import { DesignImage } from "@/components/ui/design-image";
import { ProjectStatus, StageStrip } from "./project-status";
import { RelativeTime } from "./relative-time";

/** Image-first project tile: cover render, name, client, status, last update, stage progress. */
export function ProjectCard({ project, priority }: { project: ProjectSummaryDTO; priority?: boolean }) {
  return (
    <Link
      href={`/projects/${project.id}`}
      className="pressable group flex flex-col gap-4 rounded-[var(--radius-card)] border border-hairline bg-surface p-3 pb-5 hover:border-hairline-strong"
    >
      <DesignImage
        src={project.coverImageUrl}
        alt={project.coverImageUrl ? `${project.projectName} cover` : ""}
        aspect="aspect-[4/3]"
        sizes="(min-width: 1280px) 30vw, (min-width: 640px) 45vw, 100vw"
        priority={priority}
        className="transition-transform duration-500 ease-out group-hover:scale-[1.01] motion-reduce:transform-none"
      />
      <div className="flex flex-col gap-3 px-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-headline text-ink">{project.projectName}</h3>
            <p className="truncate text-callout text-ink-2">{project.clientName}</p>
          </div>
          <ProjectStatus status={project.status} className="shrink-0" />
        </div>
        <StageStrip status={project.status} failedFrom={project.failedFromStatus} compact />
        <RelativeTime iso={project.updatedAt} prefix="Updated" className="text-caption text-ink-3" />
      </div>
    </Link>
  );
}
