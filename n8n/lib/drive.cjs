/**
 * Google Drive delivery logic for "[3D Studio] M1 · Drive — export" (inlined into its Code nodes,
 * shared with the app's unit tests). Plain JavaScript, no imports.
 *
 * The workflow is a loop: nextAction(state) says which Drive call to make for the next item,
 * applyResult(state, …) records the answer. Identity never depends on names:
 *   1. a stored Drive ID (from the database) is verified and reused;
 *   2. otherwise the item is looked up by its appProperties tag (finds items created by a run that
 *      crashed before it could save the ID);
 *   3. only then is it created, and its ID is saved immediately.
 * File content is uploaded separately (PATCH media), so a re-run overwrites instead of duplicating.
 *
 * 3D PROJECTS/
 *   <ID8> - <Project name>/
 *     01_CONCEPTS/     C01 - <title>.png …
 *     02_REVISIONS/    C01 - Revision 01.png …
 *     03_APPROVED_DESIGN/  MASTER.png FRONT.png BACK.png LEFT.png RIGHT.png
 *     04_METADATA/     project.json
 */

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_MAX_ATTEMPTS = 4;
const DRIVE_RETRYABLE = [408, 425, 429, 500, 502, 503, 504];
const RATE_LIMIT_REASONS = ["rateLimitExceeded", "userRateLimitExceeded", "backendError"];
const MAX_STEPS = 600;
const SUBFOLDERS = ["01_CONCEPTS", "02_REVISIONS", "03_APPROVED_DESIGN", "04_METADATA"];
const VIEWS = ["FRONT", "BACK", "LEFT", "RIGHT"];

const DRIVE_FAILURES = {
  drive_unavailable: "Google Drive is temporarily unavailable. The files that were uploaded are kept; retry to upload the rest.",
  drive_auth: "Google Drive rejected the studio's credentials. An administrator needs to reconnect the Google Drive account in n8n.",
  drive_rejected: "Google Drive rejected this upload. Retry, or contact the studio if it keeps failing.",
  source_missing: "The image for this file couldn't be read from the studio's storage.",
  blocked: "Not uploaded because its folder couldn't be created.",
  too_many_steps: "The upload took too many steps and was stopped. Retry to continue.",
};

/** Safe Drive name: no path or control characters, no leading/trailing dots, bounded length. */
function safeName(value, fallback) {
  const s = String(value || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80)
    .trim();
  return s || fallback || "Untitled";
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * claim: start_drive_export() row { export_id, plan }; config: { drive_mode, drive_parent_folder_id }.
 */
function buildPlan(claim, config) {
  const plan = claim.plan || {};
  const project = plan.project || {};
  const stored = plan.items || {};
  const cfg = config || {};
  const parent = /^[\w-]{10,}$/.test(String(cfg.drive_parent_folder_id || "")) ? cfg.drive_parent_folder_id : "root";
  const items = [];
  const add = (key, kind, name, parentKey, extra) => {
    const s = key === "root" ? plan.root || {} : stored[key] || {};
    items.push({
      key,
      kind,
      name,
      parent: parentKey,
      tag: key === "root" ? "root:3d-projects" : `${project.id}:${key}`,
      drive_file_id: s.drive_file_id || null,
      drive_url: s.drive_url || null,
      uploaded_asset_id: s.uploaded_asset_id || null,
      source_asset_id: null,
      content: null,
      mime: kind === "FOLDER" ? FOLDER_MIME : "image/png",
      status: "PENDING",
      step: s.drive_file_id ? "verify" : "search",
      attempts: 0,
      error: null,
      ...extra,
    });
  };

  add("root", "FOLDER", "3D PROJECTS", null);
  add("folder:project", "FOLDER", `${String(project.id || "").slice(0, 8).toUpperCase()} - ${safeName(project.name, "Project")}`, "root");
  for (const f of SUBFOLDERS) add(`folder:${f}`, "FOLDER", f, "folder:project");
  for (const c of plan.concepts || []) {
    add(`file:CONCEPT_${pad(c.number)}`, "FILE", `C${pad(c.number)} - ${safeName(c.title, "Concept")}.png`, "folder:01_CONCEPTS", {
      source_asset_id: c.asset_id,
      content: "asset",
    });
  }
  for (const r of plan.revisions || []) {
    add(`file:REVISION_${pad(r.concept_number)}_${pad(r.number)}`, "FILE", `C${pad(r.concept_number)} - Revision ${pad(r.number)}.png`, "folder:02_REVISIONS", {
      source_asset_id: r.asset_id,
      content: "asset",
    });
  }
  add("file:MASTER", "FILE", "MASTER.png", "folder:03_APPROVED_DESIGN", { source_asset_id: (plan.final_design || {}).master_asset_id, content: "asset" });
  const views = Object.fromEntries((plan.views || []).map((v) => [v.type, v]));
  for (const t of VIEWS) {
    add(`file:${t}`, "FILE", `${t}.png`, "folder:03_APPROVED_DESIGN", { source_asset_id: (views[t] || {}).asset_id || null, content: "asset" });
  }
  // Written last, so it can list the Drive IDs of everything above. Always re-uploaded (same file).
  add("file:METADATA", "FILE", "project.json", "folder:04_METADATA", { content: "metadata", mime: "application/json" });

  return {
    project_id: project.id,
    export_id: claim.export_id,
    mode: cfg.drive_mode === "live" ? "live" : "test",
    parent_folder_id: parent,
    plan: { project, final_design: plan.final_design || {}, approved_concept: plan.approved_concept || null, approved_revision: plan.approved_revision || null },
    items,
    steps: 0,
    auth_failed: false,
    started_at: new Date().toISOString(),
  };
}

const find = (state, key) => state.items.find((i) => i.key === key);

function apiRequest(state, item) {
  const parentId = item.parent ? find(state, item.parent).drive_file_id : null;
  const all = "supportsAllDrives=true";
  switch (item.step) {
    case "verify":
      return { method: "GET", path: `/drive/v3/files/${encodeURIComponent(item.drive_file_id)}?fields=id,name,trashed,webViewLink&${all}` };
    case "search": {
      const q = `appProperties has { key='studio_item' and value='${item.tag}' } and trashed=false`;
      return {
        method: "GET",
        path: `/drive/v3/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id,name,trashed,webViewLink)")}&spaces=drive&includeItemsFromAllDrives=true&${all}`,
      };
    }
    case "create":
      return {
        method: "POST",
        path: `/drive/v3/files?fields=id,name,webViewLink&${all}`,
        body: {
          name: item.name,
          mimeType: item.mime,
          parents: [item.key === "root" ? state.parent_folder_id : parentId],
          appProperties: { studio_item: item.tag, ...(state.project_id && item.key !== "root" ? { studio_project: state.project_id } : {}) },
        },
      };
    default:
      return { method: "PATCH", path: `/upload/drive/v3/files/${encodeURIComponent(item.drive_file_id)}?uploadType=media&fields=id,name,webViewLink,md5Checksum,size&${all}` };
  }
}

/** Next Drive call: { op: "api" | "upload_asset" | "upload_json" | "finish", item_key, request, … }. */
function nextAction(input) {
  const state = { ...input, items: input.items.map((i) => ({ ...i })), steps: (input.steps || 0) + 1 };
  if (state.steps > MAX_STEPS) {
    for (const i of state.items) if (i.status === "PENDING") Object.assign(i, { status: "FAILED", error: DRIVE_FAILURES.too_many_steps });
  }
  for (const item of state.items) {
    if (item.status !== "PENDING") continue;
    if (state.auth_failed) {
      Object.assign(item, { status: "FAILED", error: DRIVE_FAILURES.drive_auth });
      continue;
    }
    const parent = item.parent ? find(state, item.parent) : null;
    if (parent && parent.status !== "DONE") {
      Object.assign(item, { status: "FAILED", error: DRIVE_FAILURES.blocked });
      continue;
    }
    if (item.content === "asset" && !item.source_asset_id) {
      Object.assign(item, { status: "FAILED", error: DRIVE_FAILURES.source_missing });
      continue;
    }
    const request = apiRequest(state, item);
    if (item.step === "upload") {
      return {
        state,
        op: item.content === "metadata" ? "upload_json" : "upload_asset",
        item_key: item.key,
        request: { ...request, contentType: item.mime },
        asset_id: item.source_asset_id,
        file_name: item.name,
        metadata: item.content === "metadata" ? metadataContent(state) : null,
      };
    }
    return { state, op: "api", item_key: item.key, request };
  }
  return { state, op: "finish", ok: state.items.every((i) => i.status === "DONE"), summary: summarize(state) };
}

function classify(result) {
  if (!result || result.transportError || !result.statusCode) return { kind: "retry", detail: String((result && result.transportError) || "no response") };
  const status = Number(result.statusCode);
  const body = result.body || {};
  const err = body.error || {};
  const reasons = (err.errors || []).map((e) => e && e.reason).filter(Boolean);
  if (status >= 200 && status < 300) return { kind: "ok", status, body };
  if (DRIVE_RETRYABLE.includes(status) || (status === 403 && reasons.some((r) => RATE_LIMIT_REASONS.includes(r)))) {
    return { kind: "retry", detail: `HTTP ${status}: ${err.message || ""}` };
  }
  if (status === 401 || status === 403) return { kind: "auth", detail: `HTTP ${status}: ${err.message || ""}` };
  if (status === 404) return { kind: "not_found", detail: `HTTP 404: ${err.message || ""}` };
  return { kind: "rejected", detail: `HTTP ${status}: ${err.message || ""}` };
}

/**
 * Applies a Drive (or asset fetch) response to the current item.
 * Returns { state, persist: item to save, delay_seconds }.
 */
function applyResult(input, itemKey, result) {
  const state = { ...input, items: input.items.map((i) => ({ ...i })) };
  const item = find(state, itemKey);
  const c = classify(result);
  let delay = 0;
  const fail = (code, detail) => Object.assign(item, { status: "FAILED", error: DRIVE_FAILURES[code], detail: String(detail || "").slice(0, 300) });
  const retryOrFail = (detail) => {
    item.attempts += 1;
    if (item.attempts < DRIVE_MAX_ATTEMPTS) delay = state.mode === "test" ? 1 : Math.min(30, 2 ** item.attempts * 2);
    else fail("drive_unavailable", detail);
  };

  if (c.kind === "retry") retryOrFail(c.detail);
  else if (c.kind === "auth") {
    fail("drive_auth", c.detail);
    state.auth_failed = true;
  } else if (item.step === "verify") {
    if (c.kind === "ok" && !c.body.trashed) {
      item.drive_url = c.body.webViewLink || item.drive_url;
      const contentCurrent = item.content === "asset" && item.uploaded_asset_id && item.uploaded_asset_id === item.source_asset_id;
      if (item.kind === "FOLDER" || contentCurrent) Object.assign(item, { status: "DONE", attempts: 0 });
      else Object.assign(item, { step: "upload", attempts: 0 });
    } else if (c.kind === "ok" || c.kind === "not_found") {
      // Deleted or trashed in Drive since the last run: find it by tag or create it again.
      Object.assign(item, { drive_file_id: null, drive_url: null, uploaded_asset_id: null, step: "search", attempts: 0 });
    } else fail("drive_rejected", c.detail);
  } else if (item.step === "search") {
    if (c.kind !== "ok") fail("drive_rejected", c.detail);
    else {
      const hit = (c.body.files || []).find((f) => !f.trashed);
      if (hit) {
        Object.assign(item, { drive_file_id: hit.id, drive_url: hit.webViewLink || null, attempts: 0 });
        if (item.kind === "FOLDER") item.status = "DONE";
        else item.step = "upload";
      } else Object.assign(item, { step: "create", attempts: 0 });
    }
  } else if (item.step === "create") {
    if (c.kind !== "ok" || !c.body.id) fail("drive_rejected", c.detail || "no id returned");
    else {
      Object.assign(item, { drive_file_id: c.body.id, drive_url: c.body.webViewLink || null, attempts: 0 });
      if (item.kind === "FOLDER") item.status = "DONE";
      else item.step = "upload";
    }
  } else if (item.step === "upload") {
    if (c.kind === "not_found" && result && result.source === "app") fail("source_missing", c.detail);
    else if (c.kind === "not_found") Object.assign(item, { drive_file_id: null, drive_url: null, step: "search", attempts: 0 });
    else if (c.kind !== "ok") fail("drive_rejected", c.detail);
    else {
      Object.assign(item, {
        status: "DONE",
        attempts: 0,
        drive_url: c.body.webViewLink || item.drive_url,
        uploaded_asset_id: item.content === "asset" ? item.source_asset_id : null,
      });
    }
  }
  if (item.status === "FAILED" || item.status === "DONE") item.attempts = item.attempts || 0;
  return { state, persist: persistable(item), delay_seconds: delay };
}

function persistable(item) {
  return {
    key: item.key,
    kind: item.kind,
    name: item.name,
    drive_file_id: item.drive_file_id,
    drive_url: item.drive_url,
    source_asset_id: item.source_asset_id || null,
    uploaded_asset_id: item.uploaded_asset_id || null,
    status: item.status,
    error: item.status === "FAILED" ? item.error : null,
    attempts: item.attempts || 0,
  };
}

function fileRef(state, key) {
  const i = find(state, key);
  return i ? { file_name: i.name, drive_file_id: i.drive_file_id, drive_url: i.drive_url, asset_id: i.source_asset_id || null } : null;
}

/** project.json: the package description. No secrets, no internal URLs. */
function metadataContent(state) {
  const p = state.plan.project || {};
  const c = state.plan.approved_concept;
  const r = state.plan.approved_revision;
  const folder = find(state, "folder:project");
  return {
    schema: "3d-studio/project@1",
    project_id: p.id,
    project_name: p.name,
    client_name: p.client_name,
    design_brief: p.design_brief,
    approved_concept: c ? { id: c.id, number: c.number, title: c.title, description: c.description, materials: c.materials, key_features: c.key_features } : null,
    approved_revision: r ? { id: r.id, number: r.number, client_feedback: r.feedback, summary: r.summary } : null,
    design_summary: (state.plan.final_design || {}).design_summary || null,
    invariants: (state.plan.final_design || {}).invariants || [],
    master_image: fileRef(state, "file:MASTER"),
    front: fileRef(state, "file:FRONT"),
    back: fileRef(state, "file:BACK"),
    left: fileRef(state, "file:LEFT"),
    right: fileRef(state, "file:RIGHT"),
    drive_folder: folder ? { id: folder.drive_file_id, url: folder.drive_url } : null,
    created_at: p.created_at,
    finalized_at: (state.plan.final_design || {}).finalized_at || null,
    completed_at: new Date().toISOString(),
  };
}

function summarize(state) {
  const by = (s) => state.items.filter((i) => i.status === s).map((i) => i.key);
  const folder = find(state, "folder:project");
  return {
    done: by("DONE").length,
    total: state.items.length,
    failed: state.items.filter((i) => i.status === "FAILED").map((i) => ({ key: i.key, error: i.error, detail: i.detail || null })),
    folder: folder ? { id: folder.drive_file_id, url: folder.drive_url } : null,
    steps: state.steps,
  };
}

const drive = { FOLDER_MIME, DRIVE_FAILURES, safeName, buildPlan, nextAction, applyResult, metadataContent, summarize };
if (typeof module !== "undefined" && module.exports) module.exports = drive;
