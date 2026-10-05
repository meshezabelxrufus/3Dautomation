import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { LoadingState } from "@/components/studio/loading-state";
import { ProjectWorkspace } from "@/components/studio/project-workspace";
import { getDb } from "@/lib/server/db";
import { uuidSchema } from "@/lib/validation/project";
import { reapStaleConceptGeneration } from "@/server/commands/projects";
import { getConcepts, getFinalViews, getProject, getProjectStatus, getRevisions } from "@/server/queries/projects";

async function load(projectId: string) {
  if (!uuidSchema.safeParse(projectId).success) return null;
  const db = getDb();
  await reapStaleConceptGeneration(db, projectId);
  const [project, status] = await Promise.all([getProject(db, projectId), getProjectStatus(db, projectId)]);
  if (!project || !status) return null;
  const [concepts, revisions, finalViews] = await Promise.all([
    getConcepts(db, projectId),
    getRevisions(db, projectId),
    getFinalViews(db, projectId),
  ]);
  return { project, status, concepts, revisions, finalViews };
}

export async function generateMetadata(props: PageProps<"/projects/[projectId]">): Promise<Metadata> {
  await connection();
  const { projectId } = await props.params;
  const project = uuidSchema.safeParse(projectId).success ? await getProject(getDb(), projectId) : null;
  return { title: project?.projectName ?? "Project" };
}

export default async function ProjectPage(props: PageProps<"/projects/[projectId]">) {
  await connection();
  const { projectId } = await props.params;
  const snapshot = await load(projectId);
  if (!snapshot) notFound();
  return (
    <Suspense fallback={<LoadingState variant="workspace" />}>
      <ProjectWorkspace initial={snapshot} />
    </Suspense>
  );
}
