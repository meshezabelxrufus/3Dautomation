import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const dr = require(path.resolve(import.meta.dirname, "../../../../n8n/lib/drive.cjs"));

const PROJECT = "8f096623-3889-44d5-9eb3-325ab1861850";

/** In-memory Drive with failure injection, speaking the same requests the workflow sends. */
function memoryDrive() {
  const files = new Map<string, { id: string; name: string; parents: string[]; trashed: boolean; app: Record<string, string>; uploads: number }>();
  let n = 0;
  const failures: { op: string; match: string; status: number; times: number }[] = [];
  const fail = (op: string, match: string, status = 500, times = 1) => failures.push({ op, match, status, times });
  const injected = (op: string, name: string) => {
    const f = failures.find((x) => x.op === op && name.includes(x.match) && x.times > 0);
    if (!f) return null;
    f.times--;
    return { statusCode: f.status, body: { error: { message: "injected", errors: [{ reason: f.status === 403 ? "forbidden" : "backendError" }] } } };
  };
  const view = (f: { id: string; name: string; trashed: boolean }) => ({ id: f.id, name: f.name, trashed: f.trashed, webViewLink: `https://drive.example/${f.id}` });
  function handle(req: { method: string; path: string; body?: Record<string, unknown> }) {
    const url = new URL(req.path, "https://x");
    const one = url.pathname.match(/^\/drive\/v3\/files\/(.+)$/);
    if (req.method === "GET" && one) {
      const f = files.get(decodeURIComponent(one[1]!));
      return injected("get", f?.name ?? "") ?? (f ? { statusCode: 200, body: view(f) } : { statusCode: 404, body: { error: { message: "File not found" } } });
    }
    if (req.method === "GET") {
      const tag = url.searchParams.get("q")!.match(/value='([^']+)'/)![1]!;
      return injected("search", tag) ?? { statusCode: 200, body: { files: [...files.values()].filter((f) => f.app.studio_item === tag && !f.trashed).map(view) } };
    }
    if (req.method === "POST") {
      const b = req.body as { name: string; parents: string[]; appProperties: Record<string, string> };
      const inj = injected("create", b.name);
      if (inj) return inj;
      const f = { id: `id${++n}`, name: b.name, parents: b.parents, trashed: false, app: b.appProperties, uploads: 0 };
      files.set(f.id, f);
      return { statusCode: 200, body: view(f) };
    }
    const up = url.pathname.match(/^\/upload\/drive\/v3\/files\/(.+)$/)!;
    const f = files.get(decodeURIComponent(up[1]!));
    const inj = injected("upload", f?.name ?? "");
    if (inj) return inj;
    if (!f) return { statusCode: 404, body: { error: { message: "File not found" } } };
    f.uploads++;
    return { statusCode: 200, body: view(f) };
  }
  return { files, fail, handle };
}

/** The workflow loop, persisting like save_drive_item does. `crashAfterCreate` drops the next persist. */
function run(drive: ReturnType<typeof memoryDrive>, db: Map<string, Record<string, unknown>>, opts: { crashAfterCreate?: string } = {}) {
  const plan = {
    project: { id: PROJECT, name: "Mechanical / Wolf: Bust?", client_name: "Northwind", design_brief: "Wolf bust.", created_at: "2026-10-01T00:00:00Z" },
    final_design: { master_asset_id: "a-master", finalized_at: "2026-10-05T00:00:00Z", design_summary: "Wolf." },
    approved_concept: { id: "c1", number: 1, title: "Iron Fang" },
    approved_revision: { id: "r2", number: 2, feedback: "smaller horns", summary: "Smaller horns." },
    views: ["FRONT", "BACK", "LEFT", "RIGHT"].map((t) => ({ type: t, asset_id: `a-${t}` })),
    concepts: [{ number: 1, title: "Iron Fang", asset_id: "a-c1" }],
    revisions: [{ concept_number: 1, number: 2, asset_id: "a-r2" }],
    root: db.get("root") ?? null,
    items: Object.fromEntries([...db.entries()].filter(([k]) => k !== "root")),
  };
  let state = dr.buildPlan({ export_id: "e1", plan }, { drive_mode: "test" });
  let uploadedJson: Record<string, unknown> | null = null;
  for (;;) {
    const action = dr.nextAction(state);
    state = action.state;
    if (action.op === "finish") return { ok: action.ok, summary: action.summary, state, metadata: uploadedJson };
    const result = drive.handle(action.request);
    if (action.op === "upload_json") uploadedJson = action.metadata;
    const applied = dr.applyResult(state, action.item_key, result);
    state = applied.state;
    if (opts.crashAfterCreate && action.request.method === "POST" && action.request.body?.name === opts.crashAfterCreate) {
      opts.crashAfterCreate = undefined;
      return { ok: false, crashed: true, state };
    }
    db.set(applied.persist.key, applied.persist);
  }
}

describe("Drive package plan", () => {
  it("lays out 3D PROJECTS / <ID8 - name> / 01..04 with safe names", () => {
    const drive = memoryDrive();
    const out = run(drive, new Map());
    expect(out.ok).toBe(true);
    const names = [...drive.files.values()].map((f) => f.name);
    expect(names).toEqual(
      expect.arrayContaining(["3D PROJECTS", "8F096623 - Mechanical Wolf Bust", "01_CONCEPTS", "02_REVISIONS", "03_APPROVED_DESIGN", "04_METADATA",
        "MASTER.png", "FRONT.png", "BACK.png", "LEFT.png", "RIGHT.png", "project.json", "C01 - Iron Fang.png", "C01 - Revision 02.png"]),
    );
    const byName = (n: string) => [...drive.files.values()].find((f) => f.name === n)!;
    expect(byName("MASTER.png").parents).toEqual([byName("03_APPROVED_DESIGN").id]);
    expect(byName("project.json").parents).toEqual([byName("04_METADATA").id]);
    expect(byName("MASTER.png").app.studio_item).toBe(`${PROJECT}:file:MASTER`);
  });

  it("safeName strips path and control characters", () => {
    expect(dr.safeName('a/b\\c:d*e?"f<g>h|i\u0001')).toBe("a b c d e f g h i");
    expect(dr.safeName("..")).toBe("Untitled");
  });

  it("project.json has the required fields, the Drive IDs, and no secrets", () => {
    const out = run(memoryDrive(), new Map());
    const m = out.metadata!;
    for (const k of ["project_id", "project_name", "client_name", "design_brief", "approved_concept", "approved_revision", "master_image", "front", "back", "left", "right", "created_at", "completed_at"]) {
      expect(m).toHaveProperty(k);
    }
    expect((m.front as { drive_file_id: string }).drive_file_id).toMatch(/^id\d+$/);
    expect(JSON.stringify(m)).not.toMatch(/token|secret|password|api[_-]?key|Bearer/i);
  });
});

describe("idempotency", () => {
  it("a repeated run reuses every stored ID: nothing new is created, images are not re-uploaded", () => {
    const drive = memoryDrive();
    const db = new Map();
    run(drive, db);
    const count = drive.files.size;
    const uploads = [...drive.files.values()].map((f) => f.uploads);
    const again = run(drive, db);
    expect(again.ok).toBe(true);
    expect(drive.files.size).toBe(count);
    const after = [...drive.files.values()].map((f) => f.uploads);
    // Only project.json is rewritten (same file); images stay as uploaded.
    expect(after.filter((u, i) => u !== uploads[i])).toHaveLength(1);
  });

  it("a run that crashed after creating a file but before saving its ID finds it by tag instead of duplicating", () => {
    const drive = memoryDrive();
    const db = new Map();
    expect(run(drive, db, { crashAfterCreate: "LEFT.png" }).crashed).toBe(true);
    expect(db.get("file:LEFT")?.drive_file_id ?? null).toBeNull(); // the ID never reached the database
    expect(run(drive, db).ok).toBe(true);
    expect([...drive.files.values()].filter((f) => f.name === "LEFT.png")).toHaveLength(1);
  });

  it("a file deleted in Drive since the last run is created again", () => {
    const drive = memoryDrive();
    const db = new Map();
    run(drive, db);
    const front = [...drive.files.values()].find((f) => f.name === "FRONT.png")!;
    front.trashed = true;
    expect(run(drive, db).ok).toBe(true);
    expect([...drive.files.values()].filter((f) => f.name === "FRONT.png" && !f.trashed)).toHaveLength(1);
  });
});

describe("failures", () => {
  it("partial failure keeps successful uploads; the retry uploads only LEFT", () => {
    const drive = memoryDrive();
    const db = new Map();
    drive.fail("upload", "LEFT.png", 500, 4); // every attempt of this run
    const first = run(drive, db);
    expect(first.ok).toBe(false);
    expect(first.summary.failed.map((f: { key: string }) => f.key)).toEqual(["file:LEFT"]);
    expect(first.summary.failed[0].error).toBe(dr.DRIVE_FAILURES.drive_unavailable);
    const uploadsBefore = Object.fromEntries([...drive.files.values()].map((f) => [f.name, f.uploads]));

    const second = run(drive, db);
    expect(second.ok).toBe(true);
    const uploadsAfter = Object.fromEntries([...drive.files.values()].map((f) => [f.name, f.uploads]));
    for (const n of ["MASTER.png", "FRONT.png", "BACK.png", "RIGHT.png"]) expect(uploadsAfter[n]).toBe(uploadsBefore[n]);
    expect(uploadsAfter["LEFT.png"]).toBe(1);
    expect([...drive.files.values()].filter((f) => f.name === "LEFT.png")).toHaveLength(1);
  });

  it("transient errors are retried within the run", () => {
    const drive = memoryDrive();
    drive.fail("create", "BACK.png", 503, 2);
    expect(run(drive, new Map()).ok).toBe(true);
  });

  it("an auth failure stops the run quickly with a clear reason", () => {
    const drive = memoryDrive();
    drive.fail("search", "root:3d-projects", 401);
    const out = run(drive, new Map());
    expect(out.ok).toBe(false);
    expect(out.summary.failed.length).toBe(out.summary.total);
    expect(out.summary.failed[0].error).toBe(dr.DRIVE_FAILURES.drive_auth);
    expect(out.summary.steps).toBeLessThan(5);
  });

  it("a folder failure blocks only what's inside it", () => {
    const drive = memoryDrive();
    drive.fail("create", "01_CONCEPTS", 400);
    const out = run(drive, new Map());
    const failed = out.summary.failed.map((f: { key: string }) => f.key);
    expect(failed).toEqual(["folder:01_CONCEPTS", "file:CONCEPT_01"]);
    expect(out.summary.failed[1].error).toBe(dr.DRIVE_FAILURES.blocked);
  });
});
