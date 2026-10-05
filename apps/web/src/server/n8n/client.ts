import "server-only";
import { N8nContractError, N8nRejectedError, N8nUnavailableError } from "./errors";

/**
 * Server-only client for this project's n8n webhooks. The browser never talks to n8n:
 * Server Actions / Route Handlers call these functions, which add the shared secret
 * header (checked by n8n's Header Auth credential) and turn failures into typed errors.
 */
export type N8nConfig = { baseUrl: string; token: string };

export function n8nConfigFromEnv(env: NodeJS.ProcessEnv = process.env): N8nConfig {
  const baseUrl = env.N8N_WEBHOOK_BASE_URL;
  const token = env.N8N_WEBHOOK_TOKEN;
  if (!baseUrl || !token) throw new N8nUnavailableError("n8n is not configured (N8N_WEBHOOK_BASE_URL / N8N_WEBHOOK_TOKEN)");
  return { baseUrl, token };
}

type ErrorBody = { error?: { code?: string; message?: string; fields?: Record<string, string> } };

export async function callWebhook<T>(
  webhookPath: string,
  payload: unknown,
  { timeoutMs = 15_000, config = n8nConfigFromEnv() }: { timeoutMs?: number; config?: N8nConfig } = {},
): Promise<{ status: number; body: T }> {
  const url = new URL(`/webhook/${webhookPath}`, config.baseUrl);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Webhook-Token": config.token },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : "unreachable";
    throw new N8nUnavailableError(`n8n webhook ${webhookPath} ${reason}`);
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    if (res.ok) throw new N8nContractError(`n8n webhook ${webhookPath} returned non-JSON`);
  }

  if (res.status >= 500) {
    throw new N8nUnavailableError(`n8n webhook ${webhookPath} failed with ${res.status}`, res.status);
  }
  if (res.status === 401 || res.status === 403) {
    // Misconfiguration (token mismatch), not a user error.
    throw new N8nUnavailableError(`n8n rejected the webhook token (${res.status})`, res.status);
  }
  if (res.status === 404) {
    throw new N8nUnavailableError(`n8n webhook ${webhookPath} is not deployed or not published`, 404);
  }
  if (!res.ok) {
    const err = (body as ErrorBody | null)?.error;
    throw new N8nRejectedError(err?.message ?? `Rejected (${res.status})`, res.status, err?.code ?? "rejected", err?.fields);
  }
  return { status: res.status, body: body as T };
}
