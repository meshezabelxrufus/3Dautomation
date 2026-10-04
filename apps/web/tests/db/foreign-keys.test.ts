import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { concepts, finalDesigns, finalViews, projectEvents, projects, revisions } from "@/db/schema";
import * as wf from "@/server/workflow/workflow";
import { inConceptReview, inViewReview, newProject, withFinalizedDesign } from "../setup/factories";
import { expectPgError, connectTestDb } from "../setup/test-db";

const { db, pool } = connectTestDb();

describe("foreign keys", () => {
  it("rejects children that reference a missing parent", async () => {
    // Raw SQL with triggers temporarily irrelevant: the phase guard reports a missing project
    // as a workflow guard, so check the FK itself on tables without a phase guard.
    await expectPgError(
      pool.query(`insert into project_events (project_id, event_type) values ($1, 'PROJECT_CREATED')`, [randomUUID()]),
      { code: "23503", constraint: "project_events_project_id_projects_id_fk" },
    );
    const { concepts: [concept] } = await inConceptReview(db, 1);
    await wf.startRefinement(db, concept!.id, { clientFeedback: "x" }); // project -> REFINING
    await expectPgError(
      pool.query(`insert into revisions (concept_id, revision_number, client_feedback) values ($1, 99, 'x')`, [
        randomUUID(),
      ]),
      { code: "23503", constraint: "revisions_concept_id_concepts_id_fk" },
    );
  });

  it("a final design cannot approve a concept from another project", async () => {
    const a = await inConceptReview(db, 1);
    const b = await inConceptReview(db, 1);
    await wf.selectConcept(db, a.concepts[0]!.id);
    // Move project A to FINALIZING through the service, then try to point at B's concept.
    const design = await wf.beginFinalization(db, a.project.id, { conceptId: a.concepts[0]!.id });
    await wf.cancelFinalization(db, design.id); // back to CONCEPT_REVIEW
    await expect(
      wf.beginFinalization(db, a.project.id, { conceptId: b.concepts[0]!.id }),
    ).rejects.toThrow(/does not belong/);

    // Same attempt at SQL level hits the composite FK.
    await wf.beginFinalization(db, a.project.id, { conceptId: a.concepts[0]!.id }).then((d) =>
      db.update(finalDesigns).set({ status: "CANCELLED" }).where(eq(finalDesigns.id, d.id)),
    );
    await expectPgError(
      db.insert(finalDesigns).values({
        projectId: a.project.id,
        approvedConceptId: b.concepts[0]!.id,
        masterImage: "x",
      }),
      { code: "23503", constraint: "final_designs_concept_same_project_fk" },
    );
  });

  it("a final design's revision must belong to its approved concept", async () => {
    const { project, concepts: cs } = await inConceptReview(db, 2);
    const rev = await wf.startRefinement(db, cs[1]!.id, { clientFeedback: "rounder" });
    await wf.completeRevision(db, rev.id, { imageUrl: "r.png", interpretedInstruction: {}, generationPrompt: "p" });
    await wf.beginFinalization(db, project.id, { conceptId: cs[0]!.id }).then((d) =>
      db.update(finalDesigns).set({ status: "CANCELLED" }).where(eq(finalDesigns.id, d.id)),
    );
    await expectPgError(
      db.insert(finalDesigns).values({
        projectId: project.id,
        approvedConceptId: cs[0]!.id,
        approvedRevisionId: rev.id, // revision of concept 2, not concept 1
        masterImage: "x",
      }),
      { code: "23503", constraint: "final_designs_revision_same_concept_fk" },
    );
  });

  it("a view cannot reference another project's final design", async () => {
    const a = await inViewReview(db);
    const b = await withFinalizedDesign(db);
    await wf.startViewGeneration(db, a.project.id, ["FRONT"]); // A -> GENERATING_VIEWS
    await expectPgError(
      db.insert(finalViews).values({
        projectId: a.project.id,
        finalDesignId: b.design.id,
        viewType: "BACK",
        versionNumber: 9,
        isCurrent: false,
      }),
      { code: "23503", constraint: "final_views_design_same_project_fk" },
    );
  });

  it("a concept referenced by a final design cannot be deleted on its own", async () => {
    const { concept } = await withFinalizedDesign(db);
    await expectPgError(db.delete(concepts).where(eq(concepts.id, concept.id)), {
      code: "23503",
      constraint: "final_designs_concept_same_project_fk",
    });
  });

  it("deleting a project cascades to every child table, including events", async () => {
    const { project } = await inViewReview(db);
    const concept = (await wf.listConcepts(db, project.id))[0]!;
    const count = async () => {
      const [c, r, d, v, e] = await Promise.all([
        db.select().from(concepts).where(eq(concepts.projectId, project.id)),
        db.select().from(revisions).where(eq(revisions.conceptId, concept.id)),
        db.select().from(finalDesigns).where(eq(finalDesigns.projectId, project.id)),
        db.select().from(finalViews).where(eq(finalViews.projectId, project.id)),
        db.select().from(projectEvents).where(eq(projectEvents.projectId, project.id)),
      ]);
      return [c.length, r.length, d.length, v.length, e.length];
    };
    const before = await count();
    expect(before[0]).toBeGreaterThan(0);
    expect(before[2]).toBe(1);
    expect(before[3]).toBe(4);
    expect(before[4]).toBeGreaterThan(5);

    await db.delete(projects).where(eq(projects.id, project.id));
    expect(await count()).toEqual([0, 0, 0, 0, 0]);
  });

  it("deleting a concept cascades to its revisions", async () => {
    const project = await newProject(db);
    await wf.startConceptGeneration(db, project.id, { requestedCount: 1 });
    const c = await wf.addConcept(db, project.id, { title: "t", description: "d", imageUrl: "i.png" });
    await wf.completeConceptGeneration(db, project.id);
    const rev = await wf.startRefinement(db, c.id, { clientFeedback: "f" });
    await db.delete(concepts).where(eq(concepts.id, c.id));
    expect(await db.query.revisions.findFirst({ where: eq(revisions.id, rev.id) })).toBeUndefined();
  });
});
