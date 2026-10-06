import { describe, expect, it, vi } from "vitest";
import { isDatabaseUnavailable, withApiErrors } from "@/server/http/responses";
import { NotFoundError } from "@/server/workflow/errors";

describe("API error mapping", () => {
  it("recognises database outages, including wrapped driver errors", () => {
    expect(isDatabaseUnavailable(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isDatabaseUnavailable(new Error("Failed query", { cause: Object.assign(new Error("x"), { code: "57P01" }) }))).toBe(true);
    expect(isDatabaseUnavailable(new Error("syntax error at or near"))).toBe(false);
  });

  it("maps errors to client-safe responses without leaking details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const down = await withApiErrors(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND postgres"), { code: "ENOTFOUND" });
    })();
    expect(down.status).toBe(503);
    expect(JSON.stringify(await down.json())).not.toMatch(/postgres|ENOTFOUND/);
    expect((await withApiErrors(async () => { throw new NotFoundError("concept", "x"); })()).status).toBe(404);
    const bug = await withApiErrors(async () => { throw new Error("secret internal detail"); })();
    expect(bug.status).toBe(500);
    expect(JSON.stringify(await bug.json())).not.toMatch(/secret internal detail/);
  });
});
