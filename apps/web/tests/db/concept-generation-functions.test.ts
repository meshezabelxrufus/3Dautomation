import { describe, expect, it } from "vitest";
import * as wf from "@/server/workflow/workflow";
import { inConceptReview, newProject, withFinalizedDesign } from "../setup/factories";
import { connectTestDb } from "../setup/test-db";

/** The database functions the n8n concept workflow calls (migration 0003). */
const { db, pool } = connectTestDb();

const start = (id: string, n = 3) =>
  pool.query(`select * from start_concept_generation($1::uuid, $2::int, 'test')`, [id, n]).then((r) => r.rows[0]);
const complete = (id: string, concepts: unknown, meta: unknown = {}) =>
  pool.query(`select * from complete_concept_generation($1::uuid, $2::jsonb, $3::jsonb)`, [id, JSON.stringify(concepts), JSON.stringify(meta)]).then((r) => r.rows[0]);
const failGen = (id: string, reason: string) =>
  pool.query(`select * from fail_concept_generation($1::uuid, $2, '{"code":"x"}'::jsonb)`, [id, reason]).then((r) => r.rows[0]);
const status = (id: string) => pool.query(`select status, failure_reason from projects where id = $1`, [id]).then((r) => r.rows[0]);
const events = (id: string) =>
  pool.query(`select event_type, payload from project_events where project_id = $1 order by id`, [id]).then((r) => r.rows);

const concept = (i: number) => ({
  title: `Direction ${i}`,
  description: `A distinct direction number ${i} with a clear silhouette and stable base.`,
  creative_direction: `Idea ${i}`,
  visual_characteristics: `Bold proportions ${i}`,
  shape_language: `Shape vocabulary ${i}`,
  key_features: ["One", "Two", "Three"],
  materials: ["Matte primer", "Metallic paint"],
  image_generation_prompt: `Render of direction ${i}`,
});

describe("start_concept_generation", () => {
  it("DRAFT -> GENERATING_CONCEPTS with an event and the project context", async () => {
    const p = await newProject(db);
    const r = await start(p.id, 4);
    expect(r).toMatchObject({ outcome: "started", current_status: "GENERATING_CONCEPTS", project_name: p.projectName });
    expect(r.design_brief).toBe(p.designBrief);
    expect(r.existing_concepts).toEqual([]);
    expect((await events(p.id)).at(-1)).toMatchObject({
      event_type: "CONCEPT_GENERATION_STARTED",
      payload: { requestedCount: 4, source: "test", retry: false },
    });
  });

  it("allows 'more ideas' from CONCEPT_REVIEW and returns earlier concepts", async () => {
    const { project } = await inConceptReview(db, 2);
    const r = await start(project.id);
    expect(r.outcome).toBe("started");
    expect(r.existing_concepts).toHaveLength(2);
  });

  it("rejects invalid states and unknown projects without changing anything", async () => {
    const { project } = await withFinalizedDesign(db); // FINALIZING
    expect(await start(project.id)).toMatchObject({ outcome: "invalid_state", current_status: "FINALIZING" });
    expect((await status(project.id)).status).toBe("FINALIZING");
    expect((await start("00000000-0000-4000-8000-000000000000")).outcome).toBe("not_found");
    const p = await newProject(db);
    expect((await start(p.id, 7)).outcome).toBe("invalid_request");
    expect((await status(p.id)).status).toBe("DRAFT");
  });

  it("a second start while generating is rejected (double click / duplicate request)", async () => {
    const p = await newProject(db);
    await start(p.id);
    expect(await start(p.id)).toMatchObject({ outcome: "invalid_state", current_status: "GENERATING_CONCEPTS" });
  });

  it("retries a project that failed during concept generation", async () => {
    const p = await newProject(db);
    await start(p.id);
    await failGen(p.id, "AI unavailable");
    const r = await start(p.id);
    expect(r.outcome).toBe("started");
    expect(await status(p.id)).toEqual({ status: "GENERATING_CONCEPTS", failure_reason: null });
    expect((await events(p.id)).at(-1).payload.retry).toBe(true);
  });
});

describe("complete_concept_generation", () => {
  it("saves READY concepts (no images yet), logs the event and moves to CONCEPT_REVIEW atomically", async () => {
    const p = await newProject(db);
    await start(p.id);
    const r = await complete(p.id, [concept(1), concept(2), concept(3)], { model: "claude-sonnet-5-5", attempts: 2 });
    expect(r.outcome).toBe("completed");
    expect(r.concept_ids).toHaveLength(3);
    expect((await status(p.id)).status).toBe("CONCEPT_REVIEW");

    const saved = await wf.listConcepts(db, p.id);
    expect(saved.map((c) => [c.conceptNumber, c.status, c.imageUrl])).toEqual([
      [1, "READY", null],
      [2, "READY", null],
      [3, "READY", null],
    ]);
    expect(saved[0]).toMatchObject({
      shapeLanguage: "Shape vocabulary 1",
      visualCharacteristics: "Bold proportions 1",
      keyFeatures: ["One", "Two", "Three"],
      generationPrompt: "Render of direction 1",
    });
    expect((await events(p.id)).at(-1)).toMatchObject({
      event_type: "CONCEPT_GENERATION_COMPLETED",
      payload: { conceptCount: 3, model: "claude-sonnet-5-5", attempts: 2 },
    });
  });

  it("continues concept numbering on 'more ideas'", async () => {
    const { project } = await inConceptReview(db, 2);
    await start(project.id);
    await complete(project.id, [concept(7), concept(8)]);
    expect((await wf.listConcepts(db, project.id)).map((c) => c.conceptNumber)).toEqual([1, 2, 3, 4]);
  });

  it("is a no-op ('stale') when the project is no longer generating", async () => {
    const p = await newProject(db);
    await start(p.id);
    await failGen(p.id, "timed out");
    expect((await complete(p.id, [concept(1)])).outcome).toBe("stale");
    expect(await wf.listConcepts(db, p.id)).toHaveLength(0);
  });

  it("rolls back completely if any concept is invalid", async () => {
    const p = await newProject(db);
    await start(p.id);
    await expect(complete(p.id, [concept(1), { ...concept(2), title: null }])).rejects.toThrow();
    expect(await wf.listConcepts(db, p.id)).toHaveLength(0);
    expect((await status(p.id)).status).toBe("GENERATING_CONCEPTS");
  });

  it("rejects a non-array payload", async () => {
    const p = await newProject(db);
    await start(p.id);
    await expect(complete(p.id, { concepts: [] })).rejects.toThrow(/array of 1-5/);
  });
});

describe("fail_concept_generation", () => {
  it("GENERATING_CONCEPTS -> FAILED with a reason and GENERATION_FAILED event", async () => {
    const p = await newProject(db);
    await start(p.id);
    expect((await failGen(p.id, "The AI service is temporarily unavailable.")).outcome).toBe("failed");
    expect(await status(p.id)).toEqual({ status: "FAILED", failure_reason: "The AI service is temporarily unavailable." });
    expect((await events(p.id)).at(-1)).toMatchObject({ event_type: "GENERATION_FAILED", payload: { stage: "CONCEPTS", code: "x" } });
  });

  it("does nothing for projects that are not generating", async () => {
    const p = await newProject(db);
    expect((await failGen(p.id, "x")).outcome).toBe("noop");
    expect((await status(p.id)).status).toBe("DRAFT");
  });
});
