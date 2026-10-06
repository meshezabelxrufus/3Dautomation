"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  createSessionToken,
  gateConfig,
  passwordMatches,
  safeNext,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "@/lib/server/session";

export type LoginState = { error?: string };

// Simple per-process brute-force brake: 5 failures per client per 10 minutes.
const failures = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 10 * 60_000;

async function clientKey() {
  const h = await headers();
  return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "local").trim();
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const gate = gateConfig();
  const next = safeNext(formData.get("next"));
  if (!gate) redirect(next);
  const key = await clientKey();
  const now = Date.now();
  const f = failures.get(key);
  if (f && f.until > now && f.count >= 5) return { error: "Too many attempts. Try again in a few minutes." };

  const password = String(formData.get("password") ?? "");
  if (!password || !passwordMatches(gate.password, password)) {
    const entry = f && f.until > now ? { count: f.count + 1, until: f.until } : { count: 1, until: now + WINDOW_MS };
    failures.set(key, entry);
    await new Promise((r) => setTimeout(r, 400));
    return { error: "That password isn't right." };
  }
  failures.delete(key);
  const h = await headers();
  const secure = (h.get("x-forwarded-proto") ?? "").includes("https") || process.env.SESSION_COOKIE_SECURE === "true";
  (await cookies()).set(SESSION_COOKIE, createSessionToken(gate.secret), {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  redirect(next);
}

export async function logoutAction() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
