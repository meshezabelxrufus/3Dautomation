"use client";

import { FolderOpen, Plus } from "lucide-react";
import { useProjects } from "@/lib/api/hooks";
import type { ProjectSummaryDTO } from "@/lib/api/types";
import { ButtonLink } from "@/components/ui/button";
import { ProjectCard } from "./project-card";

/** Projects grid, kept fresh by polling (faster while any project is being worked on). */
export function ProjectsList({ initial }: { initial: ProjectSummaryDTO[] }) {
  const { data: projects } = useProjects(initial);
  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center gap-5 rounded-[var(--radius-card)] border border-dashed border-hairline-strong px-6 py-20 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-sunken text-ink-2">
          <FolderOpen className="size-6" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <div className="flex max-w-sm flex-col gap-2">
          <h2 className="text-headline text-ink">No projects yet</h2>
          <p className="text-callout text-ink-2">Describe a 3D design idea and get a set of concepts to review.</p>
        </div>
        <ButtonLink href="/projects/new" size="lg" icon={<Plus className="size-4" />}>
          Create new project
        </ButtonLink>
      </div>
    );
  }
  return (
    <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((p, i) => (
        <li key={p.id}>
          <ProjectCard project={p} priority={i < 3} />
        </li>
      ))}
    </ul>
  );
}
