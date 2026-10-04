import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ProjectDTO } from "@/lib/api/types";
import { statusMeta } from "@/lib/workflow-ui";
import { ProjectStatus } from "./project-status";

/** Wayfinding: where am I (project, client), what state is it in, how do I get back. */
export function WorkspaceHeader({ project }: { project: ProjectDTO }) {
  return (
    <header className="flex flex-col gap-6">
      <Link
        href="/projects"
        className="pressable -ml-1 inline-flex w-fit items-center gap-1.5 rounded-full px-1 text-callout text-ink-2 hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Projects
      </Link>
      <div className="flex flex-col gap-2">
        <p className="text-callout text-ink-2">{project.clientName}</p>
        <h1 className="text-display text-balance text-ink">{project.projectName}</h1>
        <p className="max-w-2xl text-body text-ink-2">{statusMeta(project.status).description}</p>
      </div>
      <ProjectStatus status={project.status} failedFrom={project.failedFromStatus} variant="stages" />
    </header>
  );
}
