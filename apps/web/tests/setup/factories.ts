/**
 * Test factories that move a project through the real workflow operations.
 * States are never written directly: the triggers would (correctly) reject that.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "@/db/client";
import type { Concept, FinalDesign, FinalView, Project } from "@/db/schema";
import { VIEW_TYPES, type ViewType } from "@/server/domain/workflow-states";
import * as wf from "@/server/workflow/workflow";

export const img = (label: string) => `assets/test/${label}-${randomUUID()}.png`;

export function newProject(db: Database, overrides: Partial<wf.CreateProjectInput> = {}): Promise<Project> {
  return wf.createProject(db, {
    projectName: "Orbit Desk Lamp",
    clientName: "Acme Studio",
    designBrief: "A minimalist desk lamp with an orbiting ring arm, printable in two parts.",
    ...overrides,
  });
}

export async function inConceptReview(db: Database, conceptCount = 3): Promise<{ project: Project; concepts: Concept[] }> {
  const project = await newProject(db);
  await wf.startConceptGeneration(db, project.id, { requestedCount: conceptCount });
  const concepts: Concept[] = [];
  for (let i = 1; i <= conceptCount; i++) {
    const c = await wf.addConcept(db, project.id, {
      title: `Concept ${i}`,
      description: `Description ${i}`,
      creativeDirection: "Soft industrial",
      keyFeatures: ["ring arm", "weighted base"],
      materials: ["PLA", "brass insert"],
      generationPrompt: `prompt ${i}`,
    });
    concepts.push(await wf.markConceptGenerated(db, c.id, { imageUrl: img(`concept-${i}`) }));
  }
  return { project: await wf.completeConceptGeneration(db, project.id), concepts };
}

export async function withFinalizedDesign(db: Database): Promise<{ project: Project; concept: Concept; design: FinalDesign }> {
  const { project, concepts } = await inConceptReview(db, 2);
  const concept = concepts[0]!;
  await wf.selectConcept(db, concept.id);
  const pending = await wf.beginFinalization(db, project.id, { conceptId: concept.id });
  const design = await wf.confirmFinalization(db, pending.id);
  return { project, concept, design };
}

export async function inViewReview(db: Database): Promise<{ project: Project; design: FinalDesign; views: FinalView[] }> {
  const { project, design } = await withFinalizedDesign(db);
  const started = await wf.startViewGeneration(db, project.id);
  const views: FinalView[] = [];
  for (const v of started) views.push(await wf.recordViewGenerated(db, v.id, { imageUrl: img(`view-${v.viewType}`) }));
  await wf.completeViewGeneration(db, project.id);
  return { project, design, views };
}

export async function withAllViewsApproved(db: Database) {
  const ctx = await inViewReview(db);
  for (const v of ctx.views) await wf.approveView(db, v.id);
  return ctx;
}

export const driveIds = (): Record<ViewType, string> =>
  Object.fromEntries(VIEW_TYPES.map((t) => [t, `drive-${t.toLowerCase()}-${randomUUID()}`])) as Record<ViewType, string>;
