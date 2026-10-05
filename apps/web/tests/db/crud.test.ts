import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { concepts, finalDesigns, finalViews, projectEvents, projects, revisions } from "@/db/schema";
import * as wf from "@/server/workflow/workflow";
import { inConceptReview, img, inViewReview, newProject, withFinalizedDesign } from "../setup/factories";
import { expectPgError, connectTestDb } from "../setup/test-db";

const { db, pool } = connectTestDb();

describe("CRUD: projects", () => {
  it("creates, reads, updates and deletes a project", async () => {
    const created = await newProject(db, { projectName: "CRUD lamp", clientName: "Client A" });
    expect(created.status).toBe("DRAFT");
    expect(created.finalizedAt).toBeNull();

    const read = await db.query.projects.findFirst({ where: eq(projects.id, created.id) });
    expect(read).toMatchObject({ projectName: "CRUD lamp", clientName: "Client A", designBrief: created.designBrief });

    await new Promise((r) => setTimeout(r, 10));
    const [updated] = await db
      .update(projects)
      .set({ projectName: "CRUD lamp v2" })
      .where(eq(projects.id, created.id))
      .returning();
    expect(updated!.projectName).toBe("CRUD lamp v2");
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime()); // trigger

    await db.delete(projects).where(eq(projects.id, created.id));
    expect(await db.query.projects.findFirst({ where: eq(projects.id, created.id) })).toBeUndefined();
  });

  it("enforces column checks", async () => {
    await expectPgError(
      db.insert(projects).values({ projectName: "", clientName: "C", designBrief: "B" }),
      { code: "23514", constraint: "projects_project_name_len" },
    );
    await expectPgError(
      db.insert(projects).values({ projectName: "P", clientName: "C", designBrief: "x".repeat(4001) }),
      { code: "23514", constraint: "projects_design_brief_len" },
    );
  });
});

describe("CRUD: concepts", () => {
  it("creates, reads, updates and deletes a concept", async () => {
    const project = await newProject(db);
    await wf.startConceptGeneration(db, project.id, { requestedCount: 2 });
    const c1 = await wf.addConcept(db, project.id, { title: "A", description: "first", keyFeatures: ["x"] });
    const c2 = await wf.addConcept(db, project.id, { title: "B", description: "second", imageUrl: img("b") });
    expect([c1.conceptNumber, c2.conceptNumber]).toEqual([1, 2]);
    expect(c1.status).toBe("GENERATING");
    expect(c2.status).toBe("READY");

    const [updated] = await db
      .update(concepts)
      .set({ description: "first, edited", materials: ["PETG", "steel"] })
      .where(eq(concepts.id, c1.id))
      .returning();
    expect(updated).toMatchObject({ description: "first, edited", materials: ["PETG", "steel"], keyFeatures: ["x"] });

    await db.delete(concepts).where(eq(concepts.id, c2.id));
    const remaining = await wf.listConcepts(db, project.id);
    expect(remaining.map((c) => c.id)).toEqual([c1.id]);
  });

  it("allows READY concepts without an image (images come later) but not FINAL ones", async () => {
    const project = await newProject(db);
    await wf.startConceptGeneration(db, project.id, { requestedCount: 1 });
    const { rows } = await pool.query(
      `insert into concepts (project_id, concept_number, title, description, status) values ($1, 1, 't', 'd', 'READY') returning id`,
      [project.id],
    );
    await expectPgError(pool.query(`update concepts set status = 'FINAL' where id = $1`, [rows[0].id]), {
      code: "23514",
      constraint: "concepts_final_requires_image",
    });
  });

  it("rejects duplicate concept numbers within a project", async () => {
    const project = await newProject(db);
    await wf.startConceptGeneration(db, project.id, { requestedCount: 1 });
    await wf.addConcept(db, project.id, { title: "A", description: "a" });
    await expectPgError(
      db.insert(concepts).values({ projectId: project.id, conceptNumber: 1, title: "dup", description: "d" }),
      { code: "23505", constraint: "concepts_project_concept_number_key" },
    );
  });
});

describe("CRUD: revisions", () => {
  it("creates, reads, updates and deletes a revision", async () => {
    const { concepts: [concept] } = await inConceptReview(db, 1);
    const rev = await wf.startRefinement(db, concept!.id, { clientFeedback: "thinner arm, matte black" });
    expect(rev).toMatchObject({ revisionNumber: 1, status: "GENERATING", interpretedInstruction: null });

    const done = await wf.completeRevision(db, rev.id, {
      imageUrl: img("rev1"),
      interpretedInstruction: { changes: ["arm thickness -30%", "finish: matte black"], preserve: ["ring shape"] },
      generationPrompt: "edit prompt",
    });
    expect(done.status).toBe("READY");
    const read = await db.query.revisions.findFirst({ where: eq(revisions.id, rev.id) });
    expect(read!.interpretedInstruction).toEqual({
      changes: ["arm thickness -30%", "finish: matte black"],
      preserve: ["ring shape"],
    });

    await db.delete(revisions).where(eq(revisions.id, rev.id));
    expect(await wf.listRevisions(db, [concept!.id])).toHaveLength(0);
  });

  it("allows only one in-flight refinement per concept", async () => {
    const { concepts: [concept] } = await inConceptReview(db, 1);
    await wf.startRefinement(db, concept!.id, { clientFeedback: "one" });
    await expectPgError(
      db.insert(revisions).values({ conceptId: concept!.id, revisionNumber: 2, clientFeedback: "two" }),
      { code: "23505", constraint: "revisions_one_generating_per_concept" },
    );
  });
});

describe("CRUD: final_designs and final_views", () => {
  it("creates and reads a final design with its master image", async () => {
    const { project, concept, design } = await withFinalizedDesign(db);
    expect(design).toMatchObject({ projectId: project.id, approvedConceptId: concept.id, status: "FINALIZED" });
    expect(design.masterImage).toBe(concept.imageUrl);
    expect(design.finalizedAt).toBeInstanceOf(Date); // trigger

    const rows = await db.select().from(finalDesigns).where(eq(finalDesigns.projectId, project.id));
    expect(rows).toHaveLength(1);
  });

  it("creates four views and updates drive_file_id", async () => {
    const { project, views } = await inViewReview(db);
    expect(views.map((v) => v.viewType).sort()).toEqual(["BACK", "FRONT", "LEFT", "RIGHT"]);
    expect(views.every((v) => v.status === "READY" && v.isCurrent && v.versionNumber === 1)).toBe(true);

    const front = views.find((v) => v.viewType === "FRONT")!;
    const [updated] = await db
      .update(finalViews)
      .set({ driveFileId: "drive-123" })
      .where(eq(finalViews.id, front.id))
      .returning();
    expect(updated!.driveFileId).toBe("drive-123");
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(front.updatedAt.getTime());

    const current = await db
      .select()
      .from(finalViews)
      .where(and(eq(finalViews.projectId, project.id), eq(finalViews.isCurrent, true)));
    expect(current).toHaveLength(4);
  });

  it("rejects an unknown view_type", async () => {
    const { project, design } = await withFinalizedDesign(db);
    await expectPgError(
      pool.query(
        `insert into final_views (project_id, final_design_id, view_type) values ($1, $2, 'TOP')`,
        [project.id, design.id],
      ),
      { code: "22P02" },
    );
  });
});

describe("CRUD: project_events", () => {
  it("records events and reads them in order", async () => {
    const project = await newProject(db);
    const [ev] = await db
      .insert(projectEvents)
      .values({ projectId: project.id, eventType: "GENERATION_FAILED", payload: { stage: "TEST" } })
      .returning();
    expect(ev!.payload).toEqual({ stage: "TEST" });
    const events = await db.select().from(projectEvents).where(eq(projectEvents.projectId, project.id));
    expect(events.map((e) => e.eventType)).toEqual(["PROJECT_CREATED", "GENERATION_FAILED"]);
  });

  it("is append-only: updates and direct deletes are rejected", async () => {
    const project = await newProject(db);
    await expectPgError(
      db.update(projectEvents).set({ payload: { tampered: true } }).where(eq(projectEvents.projectId, project.id)),
      { code: "23514", constraint: "project_events_append_only" },
    );
    await expectPgError(db.delete(projectEvents).where(eq(projectEvents.projectId, project.id)), {
      code: "23514",
      constraint: "project_events_append_only",
    });
  });

  it("requires an object payload", async () => {
    const project = await newProject(db);
    await expectPgError(
      pool.query(`insert into project_events (project_id, event_type, payload) values ($1, 'PROJECT_CREATED', '[1,2]')`, [
        project.id,
      ]),
      { code: "23514", constraint: "project_events_payload_object" },
    );
  });
});
