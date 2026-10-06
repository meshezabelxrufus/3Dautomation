import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, passwordMatches, safeNext, SESSION_COOKIE, verifySessionToken } from "@/lib/server/session";
import { proxy } from "@/proxy";

const SECRET = "x".repeat(64);

describe("session tokens", () => {
  it("valid until expiry; tampering or a different secret fails", () => {
    const t = createSessionToken(SECRET, 1_000_000);
    expect(verifySessionToken(SECRET, t, 1_000_000)).toBe(true);
    expect(verifySessionToken(SECRET, t, 1_000_000 + 31 * 24 * 3600 * 1000)).toBe(false);
    const [exp, mac] = t.split(".");
    expect(verifySessionToken(SECRET, `${Number(exp) + 999}.${mac}`, 1_000_000)).toBe(false);
    expect(verifySessionToken("y".repeat(64), t, 1_000_000)).toBe(false);
    expect(verifySessionToken("short", createSessionToken("short"), Date.now())).toBe(false);
    expect(verifySessionToken(SECRET, undefined)).toBe(false);
  });

  it("password check and post-login redirect are safe", () => {
    expect(passwordMatches("correct horse", "correct horse")).toBe(true);
    expect(passwordMatches("correct horse", "correct hors")).toBe(false);
    expect(safeNext("/projects/1")).toBe("/projects/1");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", undefined, 3]) expect(safeNext(bad)).toBe("/");
  });
});

describe("proxy (access gate)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const req = (path: string, init: { cookie?: string; headers?: Record<string, string> } = {}) =>
    new NextRequest(`http://localhost:3000${path}`, {
      headers: { ...(init.cookie ? { cookie: `${SESSION_COOKIE}=${init.cookie}` } : {}), ...(init.headers ?? {}) },
    });

  it("is off when no password is configured", () => {
    vi.stubEnv("STUDIO_ACCESS_PASSWORD", "");
    expect(proxy(req("/projects")).headers.get("x-middleware-next")).toBe("1");
  });

  it("redirects pages to /login, answers 401 for API routes and Server Actions", () => {
    vi.stubEnv("STUDIO_ACCESS_PASSWORD", "pw");
    vi.stubEnv("STUDIO_SESSION_SECRET", SECRET);
    const page = proxy(req("/projects/abc?concept=1"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("http://localhost:3000/login?next=%2Fprojects%2Fabc%3Fconcept%3D1");
    expect(proxy(req("/api/projects")).status).toBe(401);
    expect(proxy(req("/api/assets/abc")).status).toBe(401);
    expect(proxy(req("/projects/abc", { headers: { "next-action": "x" } })).status).toBe(401);
  });

  it("lets a valid session through; exempts login, health and token-protected internal routes", () => {
    vi.stubEnv("STUDIO_ACCESS_PASSWORD", "pw");
    vi.stubEnv("STUDIO_SESSION_SECRET", SECRET);
    expect(proxy(req("/projects", { cookie: createSessionToken(SECRET) })).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(req("/projects", { cookie: "123.forged" })).status).toBe(307);
    for (const p of ["/login", "/api/health", "/api/internal/assets"]) expect(proxy(req(p)).headers.get("x-middleware-next")).toBe("1");
  });

  it("fails closed when the signing secret is missing", () => {
    vi.stubEnv("STUDIO_ACCESS_PASSWORD", "pw");
    vi.stubEnv("STUDIO_SESSION_SECRET", "");
    expect(proxy(req("/projects")).status).toBe(503);
  });
});
