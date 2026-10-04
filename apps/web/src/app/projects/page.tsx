import type { Metadata } from "next";
import { connection } from "next/server";
import { Plus } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { ProjectsList } from "@/components/studio/projects-list";
import { getDb } from "@/lib/server/db";
import { listProjects } from "@/server/queries/projects";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage() {
  await connection();
  const projects = await listProjects(getDb());
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-display text-ink">Projects</h1>
          <p className="text-body text-ink-2">Every design, from first brief to delivered views.</p>
        </div>
        <ButtonLink href="/projects/new" size="lg" icon={<Plus className="size-4" />}>
          Create new project
        </ButtonLink>
      </div>
      <ProjectsList initial={projects} />
    </div>
  );
}
