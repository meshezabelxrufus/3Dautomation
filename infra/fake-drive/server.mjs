/**
 * Google Drive v3 test double for local development and tests (never used in production).
 * Implements only what "[3D Studio] M1 · Drive — export" calls:
 *
 *   GET    /drive/v3/files/:id                   metadata (404 if missing; trashed flag)
 *   GET    /drive/v3/files?q=appProperties has { key='K' and value='V' } and trashed=false
 *   POST   /drive/v3/files                       create metadata (folders, file placeholders)
 *   PATCH  /upload/drive/v3/files/:id?uploadType=media   upload content
 *
 * Failure injection and inspection (no auth):
 *   POST /__admin/fail   { "match": "LEFT", "times": 1, "status": 500, "op": "upload" }  fail matching requests
 *   POST /__admin/trash  { "match": "FRONT" }   mark matching files trashed (simulates a user deleting it)
 *   GET  /__admin/state  all files;  POST /__admin/reset  clear everything;  POST /__admin/clear-failures
 *
 * Requires an Authorization header on API calls (401 otherwise), like Google.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 4010);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const files = new Map();
let failures = [];

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const googleError = (res, status, message) => json(res, status, { error: { code: status, message, errors: [{ message }] } });
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
const view = (f) => ({
  kind: "drive#file",
  id: f.id,
  name: f.name,
  mimeType: f.mimeType,
  parents: f.parents,
  trashed: f.trashed,
  appProperties: f.appProperties,
  webViewLink: `${PUBLIC_URL}/view/${f.id}`,
  ...(f.size !== undefined ? { size: String(f.size), md5Checksum: f.md5 } : {}),
});

function injected(op, name) {
  const i = failures.findIndex((f) => (!f.op || f.op === op) && (!f.match || String(name || "").includes(f.match)));
  if (i < 0) return null;
  const f = failures[i];
  f.times -= 1;
  if (f.times <= 0) failures.splice(i, 1);
  return f.status || 500;
}

createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  const path = url.pathname;
  try {
    // ------------------------------------------------------------ admin
    if (path === "/__admin/state") return json(res, 200, { files: [...files.values()].map(view), failures });
    if (path === "/__admin/reset" && req.method === "POST") {
      files.clear();
      failures = [];
      return json(res, 200, { ok: true });
    }
    if (path === "/__admin/clear-failures" && req.method === "POST") {
      failures = [];
      return json(res, 200, { ok: true });
    }
    if (path === "/__admin/fail" && req.method === "POST") {
      const f = JSON.parse((await readBody(req)).toString() || "{}");
      failures.push({ match: f.match ?? null, times: f.times ?? 1, status: f.status ?? 500, op: f.op ?? null });
      return json(res, 200, { failures });
    }
    if (path === "/__admin/trash" && req.method === "POST") {
      const { match } = JSON.parse((await readBody(req)).toString() || "{}");
      let n = 0;
      for (const f of files.values()) if (f.name.includes(match)) (f.trashed = true), n++;
      return json(res, 200, { trashed: n });
    }
    if (path.startsWith("/view/")) return json(res, 200, { note: "Drive test double", id: path.slice(6) });

    // ------------------------------------------------------------ API
    if (!req.headers.authorization) return googleError(res, 401, "Request is missing required authentication credential.");

    const one = path.match(/^\/drive\/v3\/files\/([\w-]+)$/);
    if (one && req.method === "GET") {
      const f = files.get(one[1]);
      const status = injected("get", f?.name);
      if (status) return googleError(res, status, "Injected failure");
      return f ? json(res, 200, view(f)) : googleError(res, 404, `File not found: ${one[1]}.`);
    }

    if (path === "/drive/v3/files" && req.method === "GET") {
      const q = url.searchParams.get("q") || "";
      const m = q.match(/appProperties has \{ key='([^']+)' and value='([^']+)' \}/);
      const status = injected("search", m?.[2]);
      if (status) return googleError(res, status, "Injected failure");
      const wantTrashed = /trashed\s*=\s*true/.test(q);
      const found = [...files.values()].filter(
        (f) => m && f.appProperties?.[m[1]] === m[2] && f.trashed === wantTrashed,
      );
      return json(res, 200, { kind: "drive#fileList", files: found.map(view) });
    }

    if (path === "/drive/v3/files" && req.method === "POST") {
      const meta = JSON.parse((await readBody(req)).toString() || "{}");
      const status = injected("create", meta.name);
      if (status) return googleError(res, status, "Injected failure");
      if (!meta.name) return googleError(res, 400, "name is required");
      for (const p of meta.parents || []) {
        if (p !== "root" && !files.has(p)) return googleError(res, 404, `File not found: ${p}.`);
      }
      const f = {
        id: randomBytes(12).toString("base64url"),
        name: meta.name,
        mimeType: meta.mimeType || "application/octet-stream",
        parents: meta.parents || ["root"],
        appProperties: meta.appProperties || {},
        trashed: false,
      };
      files.set(f.id, f);
      return json(res, 200, view(f));
    }

    const up = path.match(/^\/upload\/drive\/v3\/files\/([\w-]+)$/);
    if (up && req.method === "PATCH") {
      const f = files.get(up[1]);
      const body = await readBody(req);
      const status = injected("upload", f?.name);
      if (status) return googleError(res, status, "Injected failure");
      if (!f) return googleError(res, 404, `File not found: ${up[1]}.`);
      f.size = body.length;
      f.md5 = createHash("md5").update(body).digest("hex");
      f.uploads = (f.uploads || 0) + 1;
      return json(res, 200, view(f));
    }

    return googleError(res, 404, `Not implemented in the test double: ${req.method} ${path}`);
  } catch (err) {
    return googleError(res, 500, String(err?.message || err));
  }
}).listen(PORT, () => console.log(`fake-drive listening on ${PORT}`));
