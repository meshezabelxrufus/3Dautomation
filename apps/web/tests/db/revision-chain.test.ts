import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { refineConcept, retryRefinement, useConceptVersion } from "@/server/commands/projects";
import { storeImage } from "@/server/assets/storage";
import { getConcepts, getRevisions } from "@/server/queries/projects";
import * as wf from "@/server/workflow/workflow";
import { newProject } from "../setup/factories";
import { connectTestDb } from "../setup/test-db";

/** Step 7: refinements form an explicit, never-overwritten revision chain (migration 0007). */
const { db, pool } = connectTestDb();
const root = mkdtempSync(path.join(tmpdir(), "chain-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ig = createRequire(import.meta.url)(path.resolve(import.meta.dirname, "../../../../n8n/lib/image-generation.cjs"));
const png = (n: number) => {
  const r = ig.mockImage({ mock_scenario: "ok", concept_number: ((n - 1) % 5) + 1, attempt: 1, concept_id: "x" });
  return Buffer.from(r.body.candidates[0].content.parts[1].inlineData.data, "base64");
};
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params).then((r) => r.rows);
const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
const noDispatch = { startRefinement: async () => {} };

/** A project in CONCEPT_REVIEW with two concepts that have images. */
async function reviewProject() {
  const p = await newProject(db);
  await one(`select * from start_concept_generation($1::uuid, 2, 'test')`, [p.id]);
  const saved = await one(`select * from save_concept_texts($1::uuid, $2::jsonb, '{}'::jsonb)`, [
    p.id,
    JSON.stringify(
      [1, 2].map((i) => ({ title: `Wolf ${i}`, description: `Mechanical wolf bust ${i}.`, key_features: ["Horns"], materials: ["Resin"], image_generation_prompt: `Wolf render ${i}` })),
    ),
  ]);
  for (const [i, id] of (saved.concept_ids as string[]).entries()) {
    await one(`select * from start_concept_image($1::uuid)`, [id]);
    const a = await storeImage(db, { projectId: p.id, kind: "CONCEPT", data: png(i + 1) }, root);
    await one(`select * from complete_concept_image($1::uuid, $2::uuid, '{}'::jsonb)`, [id, a.id]);
  }
  await one(`select * from finish_concept_generation($1::uuid, $2::uuid[], '{}'::jsonb)`, [p.id, saved.concept_ids]);
  return { projectId: p.id, conceptId: saved.concept_ids[0] as string, otherConceptId: saved.concept_ids[1] as string };
}

/** What n8n does when Claude + the image model succeed. */
async function completeAsN8n(projectId: string, revisionId: string, n: number) {
  const a = await storeImage(db, { projectId, kind: "REVISION", data: png(n + 1) }, root);
  const interpretation = {
    summary: `Change ${n}.`,
    changes: [`change ${n}`],
    preserve: ["wolf identity", "armour"],
    edit_prompt: `Edit this product render: change ${n}.`,
    revised_prompt: `Full revised prompt ${n}`,
  };
  const r = await one(`select * from complete_refinement($1::uuid, $2::uuid, $3::jsonb, $4, '{}'::jsonb)`, [
    revisionId,
    a.id,
    JSON.stringify(interpretation),
    `Edit this product render: change ${n}.`,
  ]);
  expect(r.outcome).toBe("completed");
  return a;
}

async function refineAndComplete(projectId: string, conceptId: string, base: string | null, feedback: string, n: number) {
  const r = await refineConcept(db, { projectId, conceptId, baseRevisionId: base, feedback }, noDispatch);
  await completeAsN8n(projectId, r.revisionId, n);
  return r;
}

const concept = (id: string) => one(`select status, active_revision_id, image_url from concepts where id = $1`, [id]);
const project = (id: string) => one(`select status from projects where id = $1`, [id]);
const revisionsOf = (conceptId: string) =>
  q(`select id, revision_number, base_revision_id, status, client_feedback, image_url, generation_prompt, error_reason
       from revisions where concept_id = $1 order by revision_number`, [conceptId]);

describe("simple and multiple refinements", () => {
  it("revision 1 is edited from the original; it becomes the current version; review resumes", async () => {
    const { projectId, conceptId } = await reviewProject();
    const r = await refineConcept(db, { projectId, conceptId, baseRevisionId: null, feedback: "Make the horns smaller." }, noDispatch);
    expect(r.revisionNumber).toBe(1);
    expect(await project(projectId)).toEqual({ status: "REFINING" });
    expect((await concept(conceptId)).status).toBe("REFINING");

    await completeAsN8n(projectId, r.revisionId, 1);
    const [rev] = await revisionsOf(conceptId);
    expect(rev).toMatchObject({ revision_number: 1, base_revision_id: null, status: "READY", client_feedback: "Make the horns smaller." });
    expect(rev.generation_prompt).toMatch(/^Edit this product render/);
    expect(await concept(conceptId)).toMatchObject({ status: "READY", active_revision_id: r.revisionId });
    expect(await project(projectId)).toEqual({ status: "CONCEPT_REVIEW" });
  });

  it("chains 1 -> 2 -> 3 and never overwrites earlier revisions", async () => {
    const { projectId, conceptId } = await reviewProject();
    const original = (await concept(conceptId)).image_url;
    const r1 = await refineAndComplete(projectId, conceptId, null, "smaller horns", 1);
    const before = await revisionsOf(conceptId);
    const r2 = await refineAndComplete(projectId, conceptId, r1.revisionId, "more mechanical body", 2);
    const r3 = await refineAndComplete(projectId, conceptId, r2.revisionId, "slightly more aggressive face", 3);

    const chain = await revisionsOf(conceptId);
    expect(chain.map((r) => [r.revision_number, r.base_revision_id])).toEqual([
      [1, null],
      [2, r1.revisionId],
      [3, r2.revisionId],
    ]);
    expect(chain[0]).toEqual(before[0]); // revision 1 untouched by later work
    expect(new Set(chain.map((r) => r.image_url)).size).toBe(3);
    expect((await concept(conceptId)).image_url).toBe(original); // revision 0 untouched
    expect((await concept(conceptId)).active_revision_id).toBe(r3.revisionId);
  });
});

describe("server-side validation (no refining the wrong thing)", () => {
  it("refuses an outdated version: the client must be looking at the current one", async () => {
    const { projectId, conceptId } = await reviewProject();
    const r1 = await refineAndComplete(projectId, conceptId, null, "smaller horns", 1);
    await expect(
      refineConcept(db, { projectId, conceptId, baseRevisionId: null, feedback: "darker" }, noDispatch),
    ).rejects.toMatchObject({ code: "stale_version", activeRevisionId: r1.revisionId });
    expect(await revisionsOf(conceptId)).toHaveLength(1);
  });

  it("refuses a concept from another project, and unknown projects", async () => {
    const a = await reviewProject();
    const b = await reviewProject();
    await expect(
      refineConcept(db, { projectId: a.projectId, conceptId: b.conceptId, baseRevisionId: null, feedback: "x" }, noDispatch),
    ).rejects.toMatchObject({ code: "concept_mismatch" });
    await expect(
      refineConcept(db, { projectId: "00000000-0000-4000-8000-000000000000", conceptId: a.conceptId, baseRevisionId: null, feedback: "x" }, noDispatch),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await revisionsOf(b.conceptId)).toHaveLength(0);
  });

  it("refuses a base revision of another concept", async () => {
    const { projectId, conceptId, otherConceptId } = await reviewProject();
    const r1 = await refineAndComplete(projectId, otherConceptId, null, "x", 1);
    await expect(
      refineConcept(db, { projectId, conceptId, baseRevisionId: r1.revisionId, feedback: "y" }, noDispatch),
    ).rejects.toMatchObject({ code: "stale_version" });
    await expect(pool.query(`update concepts set active_revision_id = $1 where id = $2`, [r1.revisionId, conceptId])).rejects.toThrow(
      /concepts_active_revision_same_concept_fk/,
    );
  });

  it("rapid repeated requests: exactly one starts, the rest are refused as busy", async () => {
    const { projectId, conceptId } = await reviewProject();
    const call = () => one(`select * from start_refinement($1::uuid, $2::uuid, null, 'smaller horns')`, [projectId, conceptId]);
    const results = await Promise.all([call(), call(), call(), call()]);
    expect(results.filter((r) => r.outcome === "started")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "busy")).toHaveLength(3);
    expect(await revisionsOf(conceptId)).toHaveLength(1);
  });

  it("only one refinement per project at a time (another concept waits too)", async () => {
    const { projectId, conceptId, otherConceptId } = await reviewProject();
    await refineConcept(db, { projectId, conceptId, baseRevisionId: null, feedback: "a" }, noDispatch);
    await expect(
      refineConcept(db, { projectId, conceptId: otherConceptId, baseRevisionId: null, feedback: "b" }, noDispatch),
    ).rejects.toMatchObject({ code: "busy" });
  });
});

describe("failure and retry", () => {
  it("a failed refinement keeps the current version, returns to review, and retries in place", async () => {
    const { projectId, conceptId } = await reviewProject();
    const r1 = await refineAndComplete(projectId, conceptId, null, "smaller horns", 1);
    const r2 = await refineConcept(db, { projectId, conceptId, baseRevisionId: r1.revisionId, feedback: "more mechanical" }, noDispatch);
    await one(`select * from fail_refinement($1::uuid, 'The AI service is temporarily unavailable. Please retry the refinement.', '{}'::jsonb)`, [r2.revisionId]);

    expect(await project(projectId)).toEqual({ status: "CONCEPT_REVIEW" });
    expect(await concept(conceptId)).toMatchObject({ status: "READY", active_revision_id: r1.revisionId });
    const failed = (await getRevisions(db, projectId)).find((r) => r.id === r2.revisionId)!;
    expect(failed).toMatchObject({ status: "FAILED", retryable: true, baseRevisionId: r1.revisionId });
    expect(failed.errorReason).toMatch(/temporarily unavailable/);

    await pool.query(`update revisions set claimed_at = now() where id = $1`, [r2.revisionId]); // the failed run had claimed it
    const dispatched: string[] = [];
    await retryRefinement(db, { projectId, conceptId, revisionId: r2.revisionId }, { startRefinement: async (j) => void dispatched.push(j.revisionId) });
    expect((await one(`select claimed_at from revisions where id = $1`, [r2.revisionId])).claimed_at).toBeNull(); // the retry run can claim it
    expect(dispatched).toEqual([r2.revisionId]);
    expect((await revisionsOf(conceptId))[1]).toMatchObject({ id: r2.revisionId, revision_number: 2, status: "GENERATING", error_reason: null });
    await completeAsN8n(projectId, r2.revisionId, 2);

    const chain = await revisionsOf(conceptId);
    expect(chain.map((r) => [r.revision_number, r.status])).toEqual([
      [1, "READY"],
      [2, "READY"],
    ]);
    expect((await concept(conceptId)).active_revision_id).toBe(r2.revisionId);
    const starts = (await q(`select payload from project_events where project_id = $1 and event_type = 'REFINEMENT_STARTED' order by id`, [projectId])).map(
      (e) => e.payload.retry,
    );
    expect(starts).toEqual([false, false, true]);
  });

  it("an older failed revision can't be retried once a newer one exists", async () => {
    const { projectId, conceptId } = await reviewProject();
    const r1 = await refineConcept(db, { projectId, conceptId, baseRevisionId: null, feedback: "a" }, noDispatch);
    await one(`select * from fail_refinement($1::uuid, 'x', '{}'::jsonb)`, [r1.revisionId]);
    await refineAndComplete(projectId, conceptId, null, "b", 2);
    expect((await getRevisions(db, projectId)).find((r) => r.id === r1.revisionId)?.retryable).toBe(false);
    await expect(retryRefinement(db, { projectId, conceptId, revisionId: r1.revisionId }, noDispatch)).rejects.toMatchObject({
      code: "not_retryable",
    });
  });

  it("if n8n can't be reached on retry, the revision fails again and nothing else changes", async () => {
    const { projectId, conceptId } = await reviewProject();
    const r1 = await refineConcept(db, { projectId, conceptId, baseRevisionId: null, feedback: "a" }, noDispatch);
    await one(`select * from fail_refinement($1::uuid, 'x', '{}'::jsonb)`, [r1.revisionId]);
    await expect(
      retryRefinement(db, { projectId, conceptId, revisionId: r1.revisionId }, { startRefinement: async () => Promise.reject(new Error("down")) }),
    ).rejects.toThrow("down");
    expect((await revisionsOf(conceptId))[0].status).toBe("FAILED");
    expect(await project(projectId)).toEqual({ status: "CONCEPT_REVIEW" });
  });
});

describe("use this version", () => {
  it("makes an older version current and approves the concept; the next refinement branches from it", async () => {
    const { projectId, conceptId } = await reviewProject();
    const r1 = await refineAndComplete(projectId, conceptId, null, "a", 1);
    const r2 = await refineAndComplete(projectId, conceptId, r1.revisionId, "b", 2);

    await useConceptVersion(db, { projectId, conceptId, revisionId: r1.revisionId });
    expect(await concept(conceptId)).toMatchObject({ status: "SELECTED", active_revision_id: r1.revisionId });

    const r3 = await refineAndComplete(projectId, conceptId, r1.revisionId, "c", 3);
    const chain = await revisionsOf(conceptId);
    expect(chain.find((r) => r.id === r3.revisionId)?.base_revision_id).toBe(r1.revisionId);
    expect(chain.find((r) => r.id === r2.revisionId)?.status).toBe("READY"); // the other branch is kept
    expect((await concept(conceptId)).active_revision_id).toBe(r3.revisionId);
  });

  it("the original (revision 0) can be made current again; invalid versions are refused", async () => {
    const { projectId, conceptId, otherConceptId } = await reviewProject();
    const r1 = await refineAndComplete(projectId, conceptId, null, "a", 1);
    await useConceptVersion(db, { projectId, conceptId, revisionId: null });
    expect((await concept(conceptId)).active_revision_id).toBeNull();
    const other = await refineAndComplete(projectId, otherConceptId, null, "x", 2);
    await expect(useConceptVersion(db, { projectId, conceptId, revisionId: other.revisionId })).rejects.toMatchObject({
      code: "invalid_version",
    });
    const failing = await refineConcept(db, { projectId, conceptId, baseRevisionId: null, feedback: "b" }, noDispatch);
    await one(`select * from fail_refinement($1::uuid, 'x', '{}'::jsonb)`, [failing.revisionId]);
    await expect(useConceptVersion(db, { projectId, conceptId, revisionId: failing.revisionId })).rejects.toMatchObject({
      code: "invalid_version",
    });
    expect(r1.revisionNumber).toBe(1);
  });

  it("the current version is what gets finalized", async () => {
    const { projectId, conceptId } = await reviewProject();
    const r1 = await refineAndComplete(projectId, conceptId, null, "a", 1);
    const [c] = (await getConcepts(db, projectId)).filter((x) => x.id === conceptId);
    expect(c!.activeRevisionId).toBe(r1.revisionId);
    const design = await wf.beginFinalization(db, projectId, { conceptId, revisionId: c!.activeRevisionId! });
    const rev = (await revisionsOf(conceptId))[0];
    expect(design.masterImage).toBe(rev.image_url);
  });
});

describe("read model for returning later", () => {
  it("revisions come back chronologically with feedback, interpretation, prompt, image and chain", async () => {
    const { projectId, conceptId } = await reviewProject();
    const r1 = await refineAndComplete(projectId, conceptId, null, "smaller horns", 1);
    await refineAndComplete(projectId, conceptId, r1.revisionId, "more mechanical", 2);
    const revs = (await getRevisions(db, projectId)).filter((r) => r.conceptId === conceptId);
    expect(revs.map((r) => r.revisionNumber)).toEqual([1, 2]);
    expect(revs[1]).toMatchObject({
      baseRevisionId: r1.revisionId,
      clientFeedback: "more mechanical",
      interpretation: "Change 2.",
      interpretationSummary: ["change 2"],
      preserved: ["wolf identity", "armour"],
      generationPrompt: "Edit this product render: change 2.",
      status: "READY",
      retryable: false,
    });
    expect(revs[1]!.imageUrl).toMatch(/^\/api\/assets\//);
  });
});

describe("concept actions are scoped to their project", () => {
  it("a concept from another project is not found", async () => {
    const { assertConceptInProject } = await import("@/server/commands/projects");
    const a = await reviewProject();
    const b = await reviewProject();
    await expect(assertConceptInProject(db, a.projectId, a.conceptId)).resolves.toBeUndefined();
    await expect(assertConceptInProject(db, a.projectId, b.conceptId)).rejects.toThrow(/not found/i);
    await expect(assertConceptInProject(db, a.projectId, "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/not found/i);
  });
});
