import { connection } from "next/server";
import { getPool } from "@/lib/server/db";

type CheckResult =
  | { status: "ok"; latencyMs: number }
  | { status: "error"; error: string }
  | { status: "not_configured" };

async function timed(fn: () => Promise<void>): Promise<CheckResult> {
  const started = performance.now();
  try {
    await fn();
    return { status: "ok", latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    // Public endpoint: no hostnames or driver messages in the response; details go to the server log.
    console.error("[health] check failed:", err instanceof Error ? err.message : err);
    return { status: "error", error: "unavailable" };
  }
}

async function checkDatabase(): Promise<CheckResult> {
  return timed(async () => {
    await getPool().query("select 1");
  });
}

async function checkN8n(): Promise<CheckResult> {
  const baseUrl = process.env.N8N_WEBHOOK_BASE_URL;
  if (!baseUrl) return { status: "not_configured" };
  return timed(async () => {
    const res = await fetch(new URL("/healthz", baseUrl), {
      signal: AbortSignal.timeout(2_000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });
}

/**
 * Liveness/readiness for Docker and operators.
 * - database: required. A failure returns 503.
 * - n8n: informational only (architecture §11.3). n8n may be restarting or
 *   hosted elsewhere, and the web app must stay up regardless.
 */
export async function GET() {
  await connection();

  const [database, n8n] = await Promise.all([checkDatabase(), checkN8n()]);
  const healthy = database.status === "ok";

  return Response.json(
    {
      status: healthy ? "ok" : "degraded",
      checks: { database, n8n },
      time: new Date().toISOString(),
    },
    {
      status: healthy ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
