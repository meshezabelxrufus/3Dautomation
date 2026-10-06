import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { reapStaleImageJobs, refineConcept, retryConceptImage } from "@/server/commands/projects";
import { AssetRejectedError, readAsset, storeImage } from "@/server/assets/storage";
import { isAuthorizedCallback } from "@/server/http/internal-auth";
import { N8nUnavailableError } from "@/server/n8n/errors";
import { WorkflowGuardError } from "@/server/workflow/errors";
import * as wf from "@/server/workflow/workflow";
import { inConceptReview, newProject } from "../setup/factories";
import { connectTestDb } from "../setup/test-db";

/** Database functions behind per-concept images and refinement (migration 0005). */
const { db, pool } = connectTestDb();
const root = mkdtempSync(path.join(tmpdir(), "assets-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Real PNGs from the n8n mock provider (the same bytes the workflows store in mock mode).
const ig = createRequire(import.meta.url)(path.resolve(import.meta.dirname, "../../../../n8n/lib/image-generation.cjs"));
const png = (n = 1) => {
  const r = ig.mockImage({ mock_scenario: "ok", concept_number: n, attempt: 1, concept_id: "x" });
  return Buffer.from(r.body.candidates[0].content.parts[1].inlineData.data, "base64");
};

const q = (sql: string, params: unknown[] = []) => pool.query(sql, params).then((r) => r.rows);
const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];

const startGeneration = (id: string, n: number) => one(`select * from start_concept_generation($1::uuid, $2::int, 'test')`, [id, n]);
const saveTexts = (id: string, n: number) =>
  one(`select * from save_concept_texts($1::uuid, $2::jsonb, '{}'::jsonb)`, [
    id,
    JSON.stringify(
      Array.from({ length: n }, (_, i) => ({
        title: `Direction ${i + 1}`,
        description: `A distinct direction number ${i + 1} with a clear silhouette.`,
        key_features: ["One", "Two"],
        materials: ["Resin"],
        image_generation_prompt: `Render of direction ${i + 1}`,
      })),
    ),
  ]);
const startImage = (conceptId: string) => one(`select * from start_concept_image($1::uuid)`, [conceptId]);
const completeImage = (conceptId: string, assetId: string) =>
  one(`select * from complete_concept_image($1::uuid, $2::uuid, '{"model":"test"}'::jsonb)`, [conceptId, assetId]);
const failImage = (conceptId: string) =>
  one(`select * from fail_concept_image($1::uuid, 'The image service is temporarily unavailable.', '{"code":"image_unavailable"}'::jsonb)`, [conceptId]);
const finish = (projectId: string, ids: string[]) =>
  one(`select * from finish_concept_generation($1::uuid, $2::uuid[], '{}'::jsonb)`, [projectId, ids]);
const project = (id: string) => one(`select status from projects where id = $1`, [id]);
const conceptRows = (projectId: string) =>
  q(`select id, concept_number, status, image_url, image_error from concepts where project_id = $1 order by concept_number`, [projectId]);
const eventTypes = (projectId: string) =>
  q(`select event_type, payload from project_events where project_id = $1 order by id`, [projectId]);

async function store(projectId: string, n = 1) {
  return storeImage(db, { projectId, kind: "CONCEPT", data: png(n), provider: "mock", model: "mock-nano-banana", prompt: "p" }, root);
}

/** A batch whose concept texts are saved and whose image jobs are all claimed. */
async function batch(n: number) {
  const p = await newProject(db);
  await startGeneration(p.id, n);
  const saved = await saveTexts(p.id, n);
  for (const id of saved.concept_ids) expect((await startImage(id)).outcome).toBe("started");
  return { projectId: p.id, ids: saved.concept_ids as string[] };
}

describe("asset storage", () => {
  it("stores validated images content-addressed and reads them back", async () => {
    const p = await newProject(db);
    const a = await store(p.id);
    expect(a).toMatchObject({ mimeType: "image/png", width: 256, height: 256, kind: "CONCEPT", provider: "mock" });
    expect(a.storageKey).toBe(`${p.id}/${a.sha256}.png`);
    const again = await store(p.id); // same bytes: same file, separate row
    expect(again.storageKey).toBe(a.storageKey);
    const read = await readAsset(db, a.id, root);
    expect(read?.data.equals(png())).toBe(true);
  });

  it("rejects anything that is not a PNG, JPEG or WebP", async () => {
    const p = await newProject(db);
    await expect(storeImage(db, { projectId: p.id, kind: "CONCEPT", data: Buffer.from("<svg/>") }, root)).rejects.toBeInstanceOf(
      AssetRejectedError,
    );
    await expect(storeImage(db, { projectId: p.id, kind: "CONCEPT", data: Buffer.alloc(0) }, root)).rejects.toBeInstanceOf(
      AssetRejectedError,
    );
  });

  it("n8n callbacks need the bearer token", () => {
    const req = (auth?: string) => new Request("http://x/api/internal/assets", { headers: auth ? { authorization: auth } : {} });
    expect(isAuthorizedCallback(req("Bearer s3cret-token"), "s3cret-token")).toBe(true);
    expect(isAuthorizedCallback(req("Bearer wrong"), "s3cret-token")).toBe(false);
    expect(isAuthorizedCallback(req(), "s3cret-token")).toBe(false);
    expect(isAuthorizedCallback(req("Bearer "), "")).toBe(false); // unset token never authorizes
  });
});

describe("concept texts first, then one image job per concept", () => {
  it("save_concept_texts makes concepts visible as GENERATING while the project keeps generating", async () => {
    const p = await newProject(db);
    await startGeneration(p.id, 3);
    const saved = await saveTexts(p.id, 3);
    expect(saved.outcome).toBe("saved");
    expect(saved.concept_ids).toHaveLength(3);
    expect((await conceptRows(p.id)).map((c) => c.status)).toEqual(["GENERATING", "GENERATING", "GENERATING"]);
    expect((await project(p.id)).status).toBe("GENERATING_CONCEPTS");
  });

  it("save_concept_texts is stale outside GENERATING_CONCEPTS", async () => {
    const p = await newProject(db);
    expect((await saveTexts(p.id, 2)).outcome).toBe("stale");
  });

  it("start_concept_image claims a job once (duplicate dispatch is in_progress)", async () => {
    const { ids } = await batch(2);
    expect(await startImage(ids[0]!)).toMatchObject({ outcome: "in_progress", concept_status: "GENERATING" });
    expect((await startImage("00000000-0000-4000-8000-000000000000")).outcome).toBe("not_found");
  });

  it("complete_concept_image attaches an app-served image and records the event", async () => {
    const { projectId, ids } = await batch(2);
    const asset = await store(projectId);
    expect((await completeImage(ids[0]!, asset.id)).outcome).toBe("completed");
    const [c1] = await conceptRows(projectId);
    expect(c1).toMatchObject({ status: "READY", image_url: `/api/assets/${asset.id}` });
    expect((await eventTypes(projectId)).at(-1)).toMatchObject({ event_type: "CONCEPT_IMAGE_GENERATED" });
    expect((await startImage(ids[0]!)).outcome).toBe("already_done");
    expect((await completeImage(ids[0]!, asset.id)).outcome).toBe("stale"); // late duplicate
  });

  it("refuses an asset that belongs to another project", async () => {
    const { ids } = await batch(2);
    const other = await newProject(db);
    const foreign = await store(other.id);
    await expect(completeImage(ids[0]!, foreign.id)).rejects.toThrow();
  });
});

describe("partial failure and retry (concept 3 of 5 fails)", () => {
  it("keeps 1, 2, 4, 5; marks 3 FAILED; review opens; retrying 3 only touches 3", async () => {
    const { projectId, ids } = await batch(5);
    for (const [i, id] of ids.entries()) {
      if (i === 2) expect((await failImage(id)).outcome).toBe("failed");
      else expect((await completeImage(id, (await store(projectId, i + 1)).id)).outcome).toBe("completed");
    }
    const done = await finish(projectId, ids);
    expect(done).toMatchObject({ outcome: "completed", images_ready: 4, images_failed: 1, current_status: "CONCEPT_REVIEW" });
    const rows = await conceptRows(projectId);
    expect(rows.map((c) => c.status)).toEqual(["READY", "READY", "FAILED", "READY", "READY"]);
    expect(rows[2].image_error).toMatch(/temporarily unavailable/);
    const completed = (await eventTypes(projectId)).find((e) => e.event_type === "CONCEPT_GENERATION_COMPLETED");
    expect(completed?.payload).toMatchObject({ conceptCount: 5, imagesReady: 4, imagesFailed: 1 });

    // Retry concept 3 in review: FAILED -> GENERATING -> READY. Nothing else changes.
    const before = rows.filter((_, i) => i !== 2).map((c) => c.image_url);
    expect(await startImage(ids[2]!)).toMatchObject({ outcome: "started", concept_number: 3, project_status: "CONCEPT_REVIEW" });
    expect((await conceptRows(projectId))[2]).toMatchObject({ status: "GENERATING", image_error: null });
    expect((await completeImage(ids[2]!, (await store(projectId, 3)).id)).outcome).toBe("completed");
    const after = await conceptRows(projectId);
    expect(after.map((c) => c.status)).toEqual(["READY", "READY", "READY", "READY", "READY"]);
    expect(after.filter((_, i) => i !== 2).map((c) => c.image_url)).toEqual(before);
    expect((await project(projectId)).status).toBe("CONCEPT_REVIEW");
  });

  it("finish fails images that never came back (and still opens review)", async () => {
    const { projectId, ids } = await batch(3);
    await completeImage(ids[0]!, (await store(projectId)).id);
    const done = await finish(projectId, ids);
    expect(done).toMatchObject({ images_ready: 1, images_failed: 2, current_status: "CONCEPT_REVIEW" });
    expect((await conceptRows(projectId)).map((c) => c.image_error)).toEqual([
      null,
      expect.stringMatching(/did not finish/),
      expect.stringMatching(/did not finish/),
    ]);
  });

  it("review needs at least one finished concept; finish on a stale project is a no-op", async () => {
    const { projectId, ids } = await batch(2);
    await expect(pool.query(`update projects set status = 'CONCEPT_REVIEW' where id = $1`, [projectId])).rejects.toThrow(
      /requires at least one generated concept/,
    );
    await finish(projectId, ids);
    expect((await finish(projectId, ids)).outcome).toBe("stale");
  });

  it("a Claude-stage failure also releases concepts waiting for images", async () => {
    const { projectId } = await batch(2);
    await one(`select * from fail_concept_generation($1::uuid, 'boom', '{}'::jsonb)`, [projectId]);
    expect((await project(projectId)).status).toBe("FAILED");
    expect((await conceptRows(projectId)).map((c) => c.status)).toEqual(["FAILED", "FAILED"]);
  });

  it("image retry is only possible while generating or in review", async () => {
    const { projectId, ids } = await batch(2);
    await failImage(ids[0]!);
    await one(`select * from fail_concept_generation($1::uuid, 'boom', '{}'::jsonb)`, [projectId]);
    expect((await startImage(ids[0]!)).outcome).toBe("invalid_state");
  });

  it("the retry command passes the concept id to n8n", async () => {
    const calls: string[] = [];
    await retryConceptImage("c-1", { retryImage: async (id) => void calls.push(id) });
    expect(calls).toEqual(["c-1"]);
  });
});

describe("refinement through n8n", () => {
  async function refinable() {
    const { projectId, ids } = await batch(2);
    for (const id of ids) await completeImage(id, (await store(projectId)).id);
    await finish(projectId, ids);
    return { projectId, conceptId: ids[0]! };
  }

  it("complete_refinement stores the edit and returns the project to review", async () => {
    const { projectId, conceptId } = await refinable();
    const dispatched: string[] = [];
    const revision = await refineConcept(
      db,
      { projectId, conceptId, baseRevisionId: null, feedback: "Thinner shade" },
      { startRefinement: async (job) => void dispatched.push(job.revisionId) },
    );
    expect(dispatched).toEqual([revision.revisionId]);
    expect((await project(projectId)).status).toBe("REFINING");

    const asset = await storeImage(db, { projectId, kind: "REVISION", data: png(2) }, root);
    const r = await one(`select * from complete_refinement($1::uuid, $2::uuid, $3::jsonb, 'edit prompt', '{}'::jsonb)`, [
      revision.revisionId,
      asset.id,
      JSON.stringify({ summary: "Thinner shade.", changes: ["thinner"], preserve: ["base"], edit_prompt: "Edit this product render: …" }),
    ]);
    expect(r.outcome).toBe("completed");
    expect(await one(`select status, image_url, generation_prompt from revisions where id = $1`, [revision.revisionId])).toEqual({
      status: "READY",
      image_url: `/api/assets/${asset.id}`,
      generation_prompt: "edit prompt",
    });
    expect((await project(projectId)).status).toBe("CONCEPT_REVIEW");
    expect((await conceptRows(projectId))[0].status).toBe("READY");
  });

  it("if n8n can't be reached the revision fails at once and review continues", async () => {
    const { projectId, conceptId } = await refinable();
    await expect(
      refineConcept(db, { projectId, conceptId, baseRevisionId: null, feedback: "Matte black" }, {
        startRefinement: async () => {
          throw new N8nUnavailableError("down");
        },
      }),
    ).rejects.toBeInstanceOf(N8nUnavailableError);
    expect(await one(`select status, error_reason from revisions where concept_id = $1`, [conceptId])).toMatchObject({
      status: "FAILED",
      error_reason: expect.stringMatching(/could not be started/),
    });
    expect((await project(projectId)).status).toBe("CONCEPT_REVIEW");
  });

  it("a concept without an image can't be refined", async () => {
    const { projectId, ids } = await batch(2);
    await expect(
      refineConcept(db, { projectId, conceptId: ids[0]!, baseRevisionId: null, feedback: "Thinner" }, { startRefinement: async () => {} }),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("restore (undo approve / undo reject) never deletes", () => {
  it("SELECTED -> READY and REJECTED -> READY, with events", async () => {
    const { project: p, concepts } = await inConceptReview(db, 2);
    await wf.selectConcept(db, concepts[0]!.id);
    await wf.rejectConcept(db, concepts[1]!.id);
    expect((await wf.restoreConcept(db, concepts[0]!.id)).status).toBe("READY");
    expect((await wf.restoreConcept(db, concepts[1]!.id)).status).toBe("READY");
    const restored = (await eventTypes(p.id)).filter((e) => e.event_type === "CONCEPT_RESTORED").map((e) => e.payload.from);
    expect(restored).toEqual(["SELECTED", "REJECTED"]);
    await expect(wf.restoreConcept(db, concepts[0]!.id)).rejects.toBeInstanceOf(WorkflowGuardError);
  });
});

describe("lazy recovery of image jobs whose n8n execution died", () => {
  it("fails a stuck retry and a stuck refinement after the deadline, not before", async () => {
    const { projectId, ids } = await batch(2);
    await completeImage(ids[0]!, (await store(projectId)).id);
    await failImage(ids[1]!);
    await finish(projectId, ids);
    await startImage(ids[1]!); // retry that never comes back
    // refinement that never comes back
    await refineConcept(db, { projectId, conceptId: ids[0]!, baseRevisionId: null, feedback: "Sharper" }, { startRefinement: async () => {} });

    expect(await reapStaleImageJobs(db, projectId)).toBe(0);
    const later = new Date(Date.now() + 12 * 60_000);
    expect(await reapStaleImageJobs(db, projectId, later)).toBe(2);
    expect((await conceptRows(projectId)).map((c) => c.status)).toEqual(["READY", "FAILED"]);
    expect((await one(`select status from revisions where concept_id = $1`, [ids[0]])).status).toBe("FAILED");
    expect((await project(projectId)).status).toBe("CONCEPT_REVIEW");
  });
});
