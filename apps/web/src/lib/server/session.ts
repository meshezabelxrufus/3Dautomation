import { createHmac, createHash, timingSafeEqual } from "node:crypto";

/**
 * Studio access gate (single shared password, signed session cookie). Enabled when
 * STUDIO_ACCESS_PASSWORD is set. Per-user accounts with project ownership are a later step
 * (docs/MILESTONE-1-ARCHITECTURE.md §9.1, open decision D1).
 */
export const SESSION_COOKIE = "studio_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export type GateConfig = { password: string; secret: string } | null;

export function gateConfig(env: NodeJS.ProcessEnv = process.env): GateConfig {
  const password = env.STUDIO_ACCESS_PASSWORD ?? "";
  if (!password) return null;
  // Fail closed: a password without a signing secret must not silently disable the gate.
  return { password, secret: env.STUDIO_SESSION_SECRET ?? "" };
}

const sign = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");

/** Token "<expiresAtSeconds>.<hmac>". */
export function createSessionToken(secret: string, now = Date.now()): string {
  const exp = String(Math.floor(now / 1000) + SESSION_TTL_SECONDS);
  return `${exp}.${sign(secret, exp)}`;
}

export function verifySessionToken(secret: string, token: string | undefined, now = Date.now()): boolean {
  if (!secret || secret.length < 32 || !token) return false;
  const [exp, mac] = token.split(".");
  if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) * 1000 < now) return false;
  const expected = Buffer.from(sign(secret, exp));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Constant-time password check (both sides hashed to equal length first). */
export function passwordMatches(expected: string, given: string): boolean {
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, b);
}

/** Only same-site relative paths are allowed as the post-login destination. */
export function safeNext(value: unknown): string {
  const v = typeof value === "string" ? value : "";
  return v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") ? v : "/";
}
