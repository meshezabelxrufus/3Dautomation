import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { approveViewsAndDeliver, finalizeDesign, generateViews, reapStaleViewJobs, refineConcept, regenerateView } from "@/server/commands/projects";
import { storeImage } from "@/server/assets/storage";
import { getFinalViews } from "@/server/queries/projects";
import { newProject } from "../setup/factories";
import { connectTestDb } from "../setup/test-db";

/** Step 8: canonical final design + four independent views (migration 0009). */
const { db, pool } = connectTestDb();
const root = mkdtempSync(path.join(tmpdir(), "views-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ig = createRequire(import.meta.url)(path.resolve(import.meta.dirname, "../../../../n8n/lib/image-generation.cjs"));
const png = (n: number) => {
  const r = ig.mockImage({ mock_scenario: "ok", concept_number: ((n - 1) % 5) + 1, attempt: 1, concept_id: "x" });
  return Buffer.from(r.body.candidates[0].content.parts[1].inlineData.data, "base64");
};
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params).then((r) => r.rows);
const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
const noViews = { generateViews: async () => ({ viewTypes: [] }) };
const PROMPTS = {
  design_summary: "A mechanical wolf bust on a round base.",
  invariants: ["Horns", "Armour", "Base"],
  front_prompt: "Using the reference image as the exact design, show the same object from the front.",
  back_prompt: "Using the reference image as the exact design, show the same object from the back.",
  left_prompt: "Using the reference image as the exact design, show the same object from the left side.",
  right_prompt: "Using the reference image as the exact design, show the same object from the right side.",
};

async function reviewProject() {
  const p = await newProject(db);
  await one(`select * from start_concept_generation($1::uuid, 2, 'test')`, [p.id]);
  const saved = await one(`select * from save_concept_texts($1::uuid, $2::jsonb, '{}'::jsonb)`, [
    p.id,
    JSON.stringify([1, 2].map((i) => ({ title: `Wolf ${i}`, description: `Wolf bust ${i}.`, key_features: ["Horns"], materials: ["Resin"], image_generation_prompt: `Wolf ${i}` }))),
  ]);
  for (const [i, id] of (saved.concept_ids as string[]).entries()) {
    await one(`select * from start_concept_image($1::uuid)`, [id]);
    const a = await storeImage(db, { projectId: p.id, kind: "CONCEPT", data: png(i + 1) }, root);
    await one(`select * from complete_concept_image($1::uuid, $2::uuid, '{}'::jsonb)`, [id, a.id]);
  }
  await one(`select * from finish_concept_generation($1::uuid, $2::uuid[], '{}'::jsonb)`, [p.id, saved.concept_ids]);
  return { projectId: p.id, conceptId: saved.concept_ids[0] as string, otherConceptId: saved.concept_ids[1] as string };
}

const finalize = (projectId: string, conceptId: string, revisionId: string | null = null) =>
  one(`select * from finalize_design($1::uuid, $2::uuid, $3::uuid)`, [projectId, conceptId, revisionId]);
const startViews = (projectId: string, designId: string, types: string[] | null = null) =>
  one(`select * from start_view_generation($1::uuid, $2::uuid, $3::view_type[])`, [projectId, designId, types]);
const project = (id: string) => one(`select status from projects where id = $1`, [id]).then((r) => r.status);
const current = (projectId: string) =>
  q(`select id, view_type, version_number, status, image_url, image_asset_id, generation_prompt, error_reason
       from final_views where project_id = $1 and is_current order by array_position(array['FRONT','BACK','LEFT','RIGHT']::view_type[], view_type)`, [projectId]);

/** What the view-image workflow does for one view. */
async function renderView(projectId: string, viewId: string, n: number) {
  const claim = await one(`select * from start_view_image($1::uuid)`, [viewId]);
  expect(claim.outcome).toBe("started");
  const a = await storeImage(db, { projectId, kind: "VIEW", data: png(n) }, root);
  expect((await one(`select * from complete_view_image($1::uuid, $2::uuid, $3, '{}'::jsonb)`, [viewId, a.id, claim.prompt])).outcome).toBe("completed");
  return claim;
}

/** Finalized design with view instructions saved and the first run started. */
async function viewsRunning() {
  const { projectId, conceptId } = await reviewProject();
  const f = await finalize(projectId, conceptId);
  const run = await startViews(projectId, f.final_design_id);
  await one(`select * from save_view_prompts($1::uuid, $2::jsonb)`, [f.final_design_id, JSON.stringify(PROMPTS)]);
  const ids = Object.fromEntries((run.views as { view_type: string; view_id: string }[]).map((v) => [v.view_type, v.view_id]));
  return { projectId, conceptId, designId: f.final_design_id as string, ids, run };
}

describe("final approval", () => {
  it("finalizing the original concept creates the canonical design from its stored image", async () => {
    const { projectId, conceptId } = await reviewProject();
    const r = await finalize(projectId, conceptId);
    expect(r).toMatchObject({ outcome: "finalized", project_status: "FINALIZING" });
    const d = await one(`select * from final_designs where id = $1`, [r.final_design_id]);
    const c = await one(`select status, image_url, image_asset_id from concepts where id = $1`, [conceptId]);
    expect(d).toMatchObject({ project_id: projectId, approved_concept_id: conceptId, approved_revision_id: null, status: "FINALIZED" });
    expect(d.master_image).toBe(c.image_url);
    expect(d.master_asset_id).toBe(c.image_asset_id);
    expect(c.status).toBe("FINAL");
    expect((await one(`select payload from project_events where project_id = $1 and event_type = 'DESIGN_FINALIZED'`, [projectId])).payload).toMatchObject({
      finalDesignId: r.final_design_id,
      revisionNumber: 0,
    });
  });

  it("finalizing a specific revision uses that revision's image", async () => {
    const { projectId, conceptId } = await reviewProject();
    const rev = await refineConcept(db, { projectId, conceptId, baseRevisionId: null, feedback: "smaller horns" }, { startRefinement: async () => {} });
    const a = await storeImage(db, { projectId, kind: "REVISION", data: png(3) }, root);
    await one(`select * from complete_refinement($1::uuid, $2::uuid, '{"summary":"x"}'::jsonb, 'p', '{}'::jsonb)`, [rev.revisionId, a.id]);
    const r = await finalize(projectId, conceptId, rev.revisionId);
    const d = await one(`select * from final_designs where id = $1`, [r.final_design_id]);
    expect(d).toMatchObject({ approved_revision_id: rev.revisionId, master_image: `/api/assets/${a.id}`, master_asset_id: a.id });
    expect((await one(`select status from revisions where id = $1`, [rev.revisionId])).status).toBe("SELECTED");
    expect((await getFinalViews(db, projectId)).finalDesign).toMatchObject({ approvedRevisionNumber: 1, conceptTitle: "Wolf 1" });
  });

  it("duplicate finalize requests are harmless: one design, same answer; a different version is refused", async () => {
    const { projectId, conceptId, otherConceptId } = await reviewProject();
    const results = await Promise.all([finalize(projectId, conceptId), finalize(projectId, conceptId), finalize(projectId, conceptId)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["already_finalized", "already_finalized", "finalized"]);
    expect(new Set(results.map((r) => r.final_design_id)).size).toBe(1);
    expect((await one(`select count(*)::int as n from final_designs where project_id = $1`, [projectId])).n).toBe(1);
    expect((await finalize(projectId, otherConceptId)).outcome).toBe("conflict");
  });

  it("the master design can't be changed afterwards", async () => {
    const { projectId, conceptId } = await reviewProject();
    const r = await finalize(projectId, conceptId);
    await expect(pool.query(`update final_designs set master_image = 'x' where id = $1`, [r.final_design_id])).rejects.toThrow(/cannot be changed/);
    await one(`select * from save_view_prompts($1::uuid, $2::jsonb)`, [r.final_design_id, JSON.stringify(PROMPTS)]);
    expect((await one(`select * from save_view_prompts($1::uuid, $2::jsonb)`, [r.final_design_id, JSON.stringify({ ...PROMPTS, front_prompt: "other" })])).outcome).toBe("kept");
    await expect(pool.query(`update final_designs set view_prompts = '{}' where id = $1`, [r.final_design_id])).rejects.toThrow(/cannot be changed/);
  });

  it("the command finalizes, then starts the views; a repeat only restarts them if they never started", async () => {
    const { projectId, conceptId } = await reviewProject();
    const calls: unknown[] = [];
    const deps = { generateViews: async (i: unknown) => (calls.push(i), { viewTypes: [] }) };
    const r = await finalizeDesign(db, { projectId, conceptId, revisionId: null }, deps);
    expect(calls).toEqual([{ projectId, finalDesignId: r.finalDesignId }]);
    await finalizeDesign(db, { projectId, conceptId, revisionId: null }, deps); // still FINALIZING: dispatch again
    expect(calls).toHaveLength(2);
    await startViews(projectId, r.finalDesignId);
    await finalizeDesign(db, { projectId, conceptId, revisionId: null }, deps); // views running: nothing to do
    expect(calls).toHaveLength(2);
    await expect(finalizeDesign(db, { projectId: "00000000-0000-4000-8000-000000000000", conceptId, revisionId: null }, noViews)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("four views", () => {
  it("first run creates FRONT/BACK/LEFT/RIGHT and returns the canonical context for Claude", async () => {
    const { projectId, conceptId } = await reviewProject();
    const f = await finalize(projectId, conceptId);
    const run = await startViews(projectId, f.final_design_id);
    expect(run.outcome).toBe("started");
    expect(run.views.map((v: { view_type: string }) => v.view_type)).toEqual(["FRONT", "BACK", "LEFT", "RIGHT"]);
    expect(run.view_prompts).toBeNull();
    expect(run.context.concept.title).toBe("Wolf 1");
    expect(await project(projectId)).toBe("GENERATING_VIEWS");
    expect((await startViews(projectId, f.final_design_id)).outcome).toBe("in_progress");
  });

  it("each view gets its own canonical instruction and the master image, never another view", async () => {
    const { projectId, designId, ids } = await viewsRunning();
    const master = (await one(`select master_asset_id from final_designs where id = $1`, [designId])).master_asset_id;
    const back = await one(`select * from start_view_image($1::uuid)`, [ids.BACK]);
    expect(back).toMatchObject({ outcome: "started", view_type: "BACK", prompt: PROMPTS.back_prompt, master_asset_id: master });
    expect((await one(`select * from start_view_image($1::uuid)`, [ids.BACK])).outcome).toBe("in_progress");
    expect(projectId).toBeTruthy();
  });

  it("all four ready -> VIEW_REVIEW", async () => {
    const { projectId, ids } = await viewsRunning();
    for (const [i, t] of ["FRONT", "BACK", "LEFT", "RIGHT"].entries()) await renderView(projectId, ids[t]!, i + 1);
    expect((await one(`select * from finish_view_generation($1::uuid, $2::uuid[])`, [projectId, Object.values(ids)])).outcome).toBe("review");
    expect(await project(projectId)).toBe("VIEW_REVIEW");
    const views = await current(projectId);
    expect(views.map((v) => [v.view_type, v.status])).toEqual([["FRONT", "READY"], ["BACK", "READY"], ["LEFT", "READY"], ["RIGHT", "READY"]]);
    expect(views[1].generation_prompt).toBe(PROMPTS.back_prompt);
  });

  it("one failure: the others are kept, only LEFT is generated again", async () => {
    const { projectId, designId, ids } = await viewsRunning();
    await renderView(projectId, ids.FRONT!, 1);
    await renderView(projectId, ids.BACK!, 2);
    await one(`select * from start_view_image($1::uuid)`, [ids.LEFT]);
    await one(`select * from fail_view_image($1::uuid, 'The image service is temporarily unavailable.', '{}'::jsonb)`, [ids.LEFT]);
    await renderView(projectId, ids.RIGHT!, 4);
    expect((await one(`select * from finish_view_generation($1::uuid, $2::uuid[])`, [projectId, Object.values(ids)])).outcome).toBe("needs_retry");
    expect(await project(projectId)).toBe("GENERATING_VIEWS");
    const before = await current(projectId);
    expect(before.map((v) => v.status)).toEqual(["READY", "READY", "FAILED", "READY"]);
    expect(before[2].error_reason).toMatch(/temporarily unavailable/);

    // A ready view can't be redone while views are being generated.
    expect((await startViews(projectId, designId, ["FRONT"])).outcome).toBe("not_retryable");
    // Retry: only the failed view gets a new version.
    const retry = await startViews(projectId, designId, null);
    expect(retry.views.map((v: { view_type: string; version_number: number }) => [v.view_type, v.version_number])).toEqual([["LEFT", 2]]);
    expect(retry.view_prompts).toMatchObject({ left_prompt: PROMPTS.left_prompt }); // no new Claude call needed
    await renderView(projectId, retry.views[0].view_id, 3);
    await one(`select * from finish_view_generation($1::uuid, $2::uuid[])`, [projectId, [retry.views[0].view_id]]);

    const after = await current(projectId);
    expect(after.map((v) => v.status)).toEqual(["READY", "READY", "READY", "READY"]);
    for (const i of [0, 1, 3]) expect(after[i]).toEqual(before[i]); // successful views untouched
    expect(await project(projectId)).toBe("VIEW_REVIEW");
  });

  it("regenerate this view: only BACK, from the master design; the old back is kept as history", async () => {
    const { projectId, designId, ids } = await viewsRunning();
    for (const [i, t] of ["FRONT", "BACK", "LEFT", "RIGHT"].entries()) await renderView(projectId, ids[t]!, i + 1);
    await one(`select * from finish_view_generation($1::uuid, $2::uuid[])`, [projectId, Object.values(ids)]);
    const before = await current(projectId);

    const regen = await startViews(projectId, designId, ["BACK"]);
    expect(regen.views).toHaveLength(1);
    expect(await project(projectId)).toBe("GENERATING_VIEWS");
    const claim = await renderView(projectId, regen.views[0].view_id, 5);
    expect(claim.master_asset_id).toBe((await one(`select master_asset_id from final_designs where id = $1`, [designId])).master_asset_id);
    expect(claim.master_asset_id).not.toBe(before[1].image_asset_id);
    await one(`select * from finish_view_generation($1::uuid, $2::uuid[])`, [projectId, [regen.views[0].view_id]]);

    const after = await current(projectId);
    expect(after[1]).toMatchObject({ view_type: "BACK", version_number: 2, status: "READY" });
    expect(after[1].image_url).not.toBe(before[1].image_url);
    for (const i of [0, 2, 3]) expect(after[i]).toEqual(before[i]);
    expect((await q(`select version_number, is_current from final_views where project_id = $1 and view_type = 'BACK' order by 1`, [projectId])).map((r) => r.is_current)).toEqual([false, true]);
    expect(await project(projectId)).toBe("VIEW_REVIEW");
  });

  it("a late result for a superseded version is ignored", async () => {
    const { projectId, designId, ids } = await viewsRunning();
    await one(`select * from start_view_image($1::uuid)`, [ids.LEFT]);
    await one(`select * from fail_view_image($1::uuid, 'x', '{}'::jsonb)`, [ids.LEFT]);
    await startViews(projectId, designId, ["LEFT"]);
    const a = await storeImage(db, { projectId, kind: "VIEW", data: png(1) }, root);
    expect((await one(`select * from complete_view_image($1::uuid, $2::uuid, 'p', '{}'::jsonb)`, [ids.LEFT, a.id])).outcome).toBe("stale");
  });

  it("if Claude can't prepare the instructions, the run's views fail and a retry starts them again", async () => {
    const { projectId, conceptId } = await reviewProject();
    const f = await finalize(projectId, conceptId);
    const run = await startViews(projectId, f.final_design_id);
    const viewIds = run.views.map((v: { view_id: string }) => v.view_id);
    await one(`select * from fail_view_preparation($1::uuid, $2::uuid[], 'The AI service is temporarily unavailable.', '{}'::jsonb)`, [projectId, viewIds]);
    expect((await current(projectId)).map((v) => v.status)).toEqual(["FAILED", "FAILED", "FAILED", "FAILED"]);
    const retry = await startViews(projectId, f.final_design_id, null);
    expect(retry.views).toHaveLength(4);
    expect(retry.view_prompts).toBeNull(); // the workflow asks Claude again
  });
});

describe("approve all views", () => {
  it("approves every view and moves to UPLOADING_TO_DRIVE (Drive itself comes later)", async () => {
    const { projectId, ids } = await viewsRunning();
    for (const [i, t] of ["FRONT", "BACK", "LEFT", "RIGHT"].entries()) await renderView(projectId, ids[t]!, i + 1);
    await expect(approveViewsAndDeliver(db, projectId)).rejects.toMatchObject({ code: "invalid_state" }); // still GENERATING_VIEWS
    await one(`select * from finish_view_generation($1::uuid, $2::uuid[])`, [projectId, Object.values(ids)]);
    await approveViewsAndDeliver(db, projectId);
    expect(await project(projectId)).toBe("UPLOADING_TO_DRIVE");
    expect((await current(projectId)).map((v) => v.status)).toEqual(["APPROVED", "APPROVED", "APPROVED", "APPROVED"]);
  });
});

describe("commands and recovery", () => {
  it("regenerate/retry go to n8n with the live final design", async () => {
    const { projectId, designId } = await viewsRunning();
    const calls: unknown[] = [];
    const deps = { generateViews: async (i: unknown) => (calls.push(i), { viewTypes: [] }) };
    await regenerateView(db, projectId, "BACK", deps);
    await generateViews(db, projectId, undefined, deps);
    expect(calls).toEqual([
      { projectId, finalDesignId: designId, viewTypes: ["BACK"] },
      { projectId, finalDesignId: designId, viewTypes: undefined },
    ]);
  });

  it("a view whose n8n run died is failed after the deadline; the rest of the run is untouched", async () => {
    const { projectId, ids } = await viewsRunning();
    await renderView(projectId, ids.FRONT!, 1);
    await one(`select * from start_view_image($1::uuid)`, [ids.BACK]);
    expect(await reapStaleViewJobs(db, projectId)).toBe(0);
    const later = new Date(Date.now() + 12 * 60_000);
    expect(await reapStaleViewJobs(db, projectId, later)).toBe(1); // claimed BACK; unclaimed LEFT/RIGHT wait for the run deadline
    expect((await current(projectId)).map((v) => v.status)).toEqual(["READY", "FAILED", "GENERATING", "GENERATING"]);
  });
});
