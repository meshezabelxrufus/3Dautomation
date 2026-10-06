import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { approveViewsAndDeliver, deliverToDrive, reapStaleDriveExports } from "@/server/commands/projects";
import { storeImage } from "@/server/assets/storage";
import { N8nRejectedError, N8nUnavailableError } from "@/server/n8n/errors";
import { getDelivery } from "@/server/queries/projects";
import { newProject } from "../setup/factories";
import { connectTestDb } from "../setup/test-db";

/** Step 9: Drive delivery state in the database (migration 0011), driven by the real n8n/lib/drive.cjs loop. */
const { db, pool } = connectTestDb();
const root = mkdtempSync(path.join(tmpdir(), "drive-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const req = createRequire(import.meta.url);
const ig = req(path.resolve(import.meta.dirname, "../../../../n8n/lib/image-generation.cjs"));
const dr = req(path.resolve(import.meta.dirname, "../../../../n8n/lib/drive.cjs"));
const png = (n: number) => {
  const r = ig.mockImage({ mock_scenario: "ok", concept_number: ((n - 1) % 5) + 1, attempt: 1, concept_id: "x" });
  return Buffer.from(r.body.candidates[0].content.parts[1].inlineData.data, "base64");
};
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params).then((r) => r.rows);
const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0];
const PROMPTS = {
  design_summary: "Wolf bust.",
  invariants: ["Horns", "Armour", "Base"],
  front_prompt: "front view",
  back_prompt: "back view",
  left_prompt: "left view",
  right_prompt: "right view",
};

/** A project whose four views were approved (UPLOADING_TO_DRIVE), built through the real functions. */
async function approvedProject() {
  const p = await newProject(db, { projectName: "Wolf / Bust: Deluxe?" });
  await one(`select * from start_concept_generation($1::uuid, 2, 'test')`, [p.id]);
  const saved = await one(`select * from save_concept_texts($1::uuid, $2::jsonb, '{}'::jsonb)`, [
    p.id,
    JSON.stringify([1, 2].map((i) => ({ title: `Wolf ${i}`, description: `Wolf ${i}.`, key_features: [], materials: [], image_generation_prompt: `w${i}` }))),
  ]);
  for (const [i, id] of (saved.concept_ids as string[]).entries()) {
    await one(`select * from start_concept_image($1::uuid)`, [id]);
    const a = await storeImage(db, { projectId: p.id, kind: "CONCEPT", data: png(i + 1) }, root);
    await one(`select * from complete_concept_image($1::uuid, $2::uuid, '{}'::jsonb)`, [id, a.id]);
  }
  await one(`select * from finish_concept_generation($1::uuid, $2::uuid[], '{}'::jsonb)`, [p.id, saved.concept_ids]);
  const f = await one(`select * from finalize_design($1::uuid, $2::uuid, null)`, [p.id, saved.concept_ids[0]]);
  const run = await one(`select * from start_view_generation($1::uuid, $2::uuid, null)`, [p.id, f.final_design_id]);
  await one(`select * from save_view_prompts($1::uuid, $2::jsonb)`, [f.final_design_id, JSON.stringify(PROMPTS)]);
  for (const [i, v] of (run.views as { view_id: string }[]).entries()) {
    const c = await one(`select * from start_view_image($1::uuid)`, [v.view_id]);
    const a = await storeImage(db, { projectId: p.id, kind: "VIEW", data: png(i + 2) }, root);
    await one(`select * from complete_view_image($1::uuid, $2::uuid, $3, '{}'::jsonb)`, [v.view_id, a.id, c.prompt]);
  }
  await one(`select * from finish_view_generation($1::uuid, $2::uuid[])`, [p.id, run.views.map((v: { view_id: string }) => v.view_id)]);
  await one(`select * from approve_all_views($1::uuid)`, [p.id]);
  return p.id;
}

/** In-memory Drive (same request shapes as Google Drive v3), with injectable failures. */
function memoryDrive() {
  const files = new Map<string, { id: string; name: string; trashed: boolean; tag: string; uploads: number }>();
  let n = 0;
  const failing: { op: string; match: string; status: number; times: number }[] = [];
  return {
    files,
    fail: (op: string, match: string, status = 500, times = 99) => failing.push({ op, match, status, times }),
    clearFailures: () => failing.splice(0),
    handle(r: { method: string; path: string; body?: { name: string; appProperties: { studio_item: string } } }) {
      const url = new URL(r.path, "https://x");
      const inj = (op: string, name: string) => {
        const f = failing.find((x) => x.op === op && name.includes(x.match) && x.times > 0);
        if (!f) return null;
        f.times--;
        return { statusCode: f.status, body: { error: { message: "injected" } } };
      };
      const v = (f: { id: string; name: string; trashed: boolean }) => ({ id: f.id, name: f.name, trashed: f.trashed, webViewLink: `https://drive.google.com/drive/folders/${f.id}` });
      const one = url.pathname.match(/^\/drive\/v3\/files\/(.+)$/);
      if (r.method === "GET" && one) {
        const f = files.get(decodeURIComponent(one[1]!));
        return f ? { statusCode: 200, body: v(f) } : { statusCode: 404, body: { error: { message: "not found" } } };
      }
      if (r.method === "GET") {
        const tag = url.searchParams.get("q")!.match(/value='([^']+)'/)![1]!;
        return inj("search", tag) ?? { statusCode: 200, body: { files: [...files.values()].filter((f) => f.tag === tag && !f.trashed).map(v) } };
      }
      if (r.method === "POST") {
        const injected = inj("create", r.body!.name);
        if (injected) return injected;
        const f = { id: `d${++n}`, name: r.body!.name, trashed: false, tag: r.body!.appProperties.studio_item, uploads: 0 };
        files.set(f.id, f);
        return { statusCode: 200, body: v(f) };
      }
      const id = decodeURIComponent(url.pathname.match(/^\/upload\/drive\/v3\/files\/(.+)$/)![1]!);
      const f = files.get(id)!;
      const injected = inj("upload", f.name);
      if (injected) return injected;
      f.uploads++;
      return { statusCode: 200, body: v(f) };
    },
  };
}

/** One n8n run: start_drive_export -> loop (save_drive_item after every step) -> complete/fail. */
async function exportRun(projectId: string, drive: ReturnType<typeof memoryDrive>) {
  const claim = await one(`select * from start_drive_export($1::uuid, 'test')`, [projectId]);
  if (claim.outcome !== "started") return { outcome: claim.outcome as string };
  let state = dr.buildPlan(claim, { drive_mode: "test" });
  for (;;) {
    const action = dr.nextAction(state);
    state = action.state;
    if (action.op === "finish") {
      if (action.ok) {
        const done = await one(`select * from complete_drive_export($1::uuid, $2::uuid, $3::jsonb)`, [projectId, claim.export_id, JSON.stringify(action.summary)]);
        return { outcome: done.outcome as string, summary: action.summary };
      }
      await one(`select * from fail_drive_export($1::uuid, $2::uuid, 'Some items failed.', $3::jsonb)`, [projectId, claim.export_id, JSON.stringify({ failedItems: action.summary.failed })]);
      return { outcome: "failed", summary: action.summary };
    }
    const applied = dr.applyResult(state, action.item_key, drive.handle(action.request));
    state = applied.state;
    await one(`select * from save_drive_item(nullif($1, '')::uuid, $2::jsonb)`, [applied.persist.key === "root" ? "" : projectId, JSON.stringify(applied.persist)]);
  }
}

const projectStatus = (id: string) => one(`select status from projects where id = $1`, [id]).then((r) => r.status);
const events = (id: string) => q(`select event_type, payload from project_events where project_id = $1 order by id`, [id]);

describe("clean upload", () => {
  it("delivers the package, stores every Drive ID, completes the project with PROJECT_COMPLETED", async () => {
    await one(`delete from drive_items where project_id is null`); // fresh "3D PROJECTS" root for this test DB
    const id = await approvedProject();
    const drive = memoryDrive();
    const out = await exportRun(id, drive);
    expect(out.outcome).toBe("completed");
    expect(await projectStatus(id)).toBe("COMPLETED");

    const items = await q(`select item_key, status, drive_file_id, drive_url from drive_items where project_id = $1 order by item_key`, [id]);
    expect(items.every((i) => i.status === "DONE" && i.drive_file_id)).toBe(true);
    expect(items.map((i) => i.item_key)).toEqual(
      expect.arrayContaining(["folder:project", "folder:01_CONCEPTS", "folder:02_REVISIONS", "folder:03_APPROVED_DESIGN", "folder:04_METADATA",
        "file:MASTER", "file:FRONT", "file:BACK", "file:LEFT", "file:RIGHT", "file:METADATA", "file:CONCEPT_01", "file:CONCEPT_02"]),
    );
    const views = await q(`select view_type, drive_file_id from final_views where project_id = $1 and is_current`, [id]);
    expect(views.every((v) => v.drive_file_id)).toBe(true);
    expect((await one(`select drive_file_id from drive_items where project_id is null and item_key = 'root'`)).drive_file_id).toBeTruthy();
    expect([...drive.files.values()].map((f) => f.name)).toContain(`${id.slice(0, 8).toUpperCase()} - Wolf Bust Deluxe`);

    const ev = (await events(id)).map((e) => e.event_type);
    expect(ev.slice(-2)).toEqual(["DRIVE_UPLOAD_COMPLETED", "PROJECT_COMPLETED"]);
    const delivery = await getDelivery(db, id);
    expect(delivery).toMatchObject({ run: { status: "COMPLETED", mode: "test" }, folder: { name: expect.stringContaining("Wolf Bust") } });
    expect(delivery.items.map((i) => i.status)).toEqual(["DONE", "DONE", "DONE", "DONE", "DONE", "DONE"]);
  });
});

describe("idempotency", () => {
  it("a repeated upload after completion does nothing (already_completed)", async () => {
    const id = await approvedProject();
    const drive = memoryDrive();
    await exportRun(id, drive);
    const count = drive.files.size;
    expect((await exportRun(id, drive)).outcome).toBe("already_completed");
    expect(drive.files.size).toBe(count);
  });

  it("the shared 3D PROJECTS root is created once for all projects", async () => {
    const drive = memoryDrive();
    const a = await approvedProject();
    const b = await approvedProject();
    await exportRun(a, drive);
    await exportRun(b, drive);
    expect([...drive.files.values()].filter((f) => f.name === "3D PROJECTS")).toHaveLength(
      (await q(`select 1 from drive_items where project_id is null`)).length,
    );
  });

  it("a duplicate webhook while a run is in progress is refused; a run that stopped responding is replaced", async () => {
    const id = await approvedProject();
    const first = await one(`select * from start_drive_export($1::uuid, 'test')`, [id]);
    expect(first.outcome).toBe("started");
    expect((await one(`select * from start_drive_export($1::uuid, 'test')`, [id])).outcome).toBe("in_progress");
    await pool.query(`update drive_exports set started_at = now() - interval '30 minutes' where id = $1`, [first.export_id]);
    expect((await one(`select * from start_drive_export($1::uuid, 'test')`, [id])).outcome).toBe("started");
    expect((await one(`select status from drive_exports where id = $1`, [first.export_id])).status).toBe("FAILED");
  });
});

describe("partial failure and retry", () => {
  it("LEFT fails: others are kept; the retry uploads only LEFT and completes", async () => {
    const id = await approvedProject();
    const drive = memoryDrive();
    drive.fail("upload", "LEFT.png", 503);
    const first = await exportRun(id, drive);
    expect(first.outcome).toBe("failed");
    expect(first.summary.failed.map((f: { key: string }) => f.key)).toEqual(["file:LEFT"]);
    expect(await projectStatus(id)).toBe("UPLOADING_TO_DRIVE");
    const delivery = await getDelivery(db, id);
    expect(delivery.run).toMatchObject({ status: "FAILED", errorReason: "Some items failed." });
    expect(delivery.items.find((i) => i.key === "file:LEFT")).toMatchObject({ status: "FAILED", error: dr.DRIVE_FAILURES.drive_unavailable });
    expect(delivery.items.find((i) => i.key === "file:FRONT")?.status).toBe("DONE");
    const before = Object.fromEntries([...drive.files.values()].map((f) => [f.name, f.uploads]));

    drive.clearFailures();
    const retry = await exportRun(id, drive);
    expect(retry.outcome).toBe("completed");
    const after = Object.fromEntries([...drive.files.values()].map((f) => [f.name, f.uploads]));
    for (const n of ["MASTER.png", "FRONT.png", "BACK.png", "RIGHT.png"]) expect(after[n]).toBe(before[n]);
    expect(after["LEFT.png"]).toBe(1);
    expect([...drive.files.values()].filter((f) => f.name === "LEFT.png")).toHaveLength(1);
    expect(await projectStatus(id)).toBe("COMPLETED");
  });

  it("a Google API outage fails the run cleanly and keeps the project retryable", async () => {
    const id = await approvedProject();
    const drive = memoryDrive();
    drive.fail("create", "", 503); // every create fails
    const out = await exportRun(id, drive);
    expect(out.outcome).toBe("failed");
    expect(await projectStatus(id)).toBe("UPLOADING_TO_DRIVE");
    expect((await events(id)).at(-1)).toMatchObject({ event_type: "GENERATION_FAILED", payload: { stage: "DRIVE" } });
    drive.clearFailures();
    expect((await exportRun(id, drive)).outcome).toBe("completed");
  });

  it("complete is refused while required items are missing", async () => {
    const id = await approvedProject();
    const claim = await one(`select * from start_drive_export($1::uuid, 'test')`, [id]);
    const r = await one(`select * from complete_drive_export($1::uuid, $2::uuid, '{}'::jsonb)`, [id, claim.export_id]);
    expect(r.outcome).toBe("incomplete");
    expect(r.missing).toContain("file:MASTER");
    expect(await projectStatus(id)).toBe("UPLOADING_TO_DRIVE");
  });
});

describe("commands", () => {
  it("approving all views starts the upload; if n8n is unreachable the approval stands", async () => {
    const id = await approvedProject();
    expect(await projectStatus(id)).toBe("UPLOADING_TO_DRIVE");
    const calls: string[] = [];
    await deliverToDrive(id, { startDriveExport: async (p) => (calls.push(p), { alreadyCompleted: false }) });
    expect(calls).toEqual([id]);
    await deliverToDrive(id, {
      startDriveExport: async () => {
        throw new N8nRejectedError("busy", 409, "export_in_progress");
      },
    }); // already running: fine
    await expect(
      deliverToDrive(id, {
        startDriveExport: async () => {
          throw new N8nUnavailableError("down");
        },
      }),
    ).rejects.toBeInstanceOf(N8nUnavailableError);
  });

  it("approving is refused unless the views are in review", async () => {
    const id = await approvedProject();
    await pool.query(`update final_views set status = 'READY' where project_id = $1 and is_current`, [id]);
    await pool.query(`update projects set status = 'FAILED', failure_reason = 'x' where id = $1`, [id]);
    expect(await approveViewsAndDeliver(db, id, { startDriveExport: async () => ({ alreadyCompleted: false }) }).catch((e) => e.code)).toBe("invalid_state");
  });

  it("a run that stopped reporting is marked failed so the client can retry", async () => {
    const id = await approvedProject();
    await one(`select * from start_drive_export($1::uuid, 'test')`, [id]);
    expect(await reapStaleDriveExports(db, id)).toBe(0);
    expect(await reapStaleDriveExports(db, id, new Date(Date.now() + 25 * 60_000))).toBe(1);
    expect((await getDelivery(db, id)).run?.status).toBe("FAILED");
  });
});
