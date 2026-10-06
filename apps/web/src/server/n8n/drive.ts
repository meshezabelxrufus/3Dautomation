import "server-only";
import { z } from "zod";
import { callWebhook, type N8nConfig } from "./client";
import { N8nContractError } from "./errors";

/** n8n workflow "[3D Studio] M1 · Drive — export" (n8n/workflows/m1-drive-export.json). */
export const DRIVE_EXPORT_WEBHOOK = "3d-studio/drive-export";

export type DriveConfig = { drive_mode: "live" | "test"; drive_parent_folder_id?: string };

/**
 * Where the package goes. Not secret: the Google credential lives only in n8n.
 * DRIVE_MODE=test uses the local Drive test double (development only).
 */
export function driveConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DriveConfig {
  return {
    drive_mode: env.DRIVE_MODE === "test" ? "test" : "live",
    ...(env.DRIVE_PARENT_FOLDER_ID ? { drive_parent_folder_id: env.DRIVE_PARENT_FOLDER_ID } : {}),
  };
}

const accepted = z.union([
  z.object({ project_id: z.uuid(), export_id: z.uuid(), status: z.literal("UPLOADING_TO_DRIVE"), accepted: z.literal(true) }),
  z.object({ project_id: z.uuid(), status: z.literal("COMPLETED"), already_completed: z.literal(true) }),
]);

/**
 * Starts (or resumes) delivering the design package to Google Drive. Idempotent on the n8n side:
 * stored Drive IDs are reused, so repeating it never duplicates folders or files.
 */
export async function startDriveExportViaN8n(
  projectId: string,
  options: { config?: N8nConfig; drive?: DriveConfig; timeoutMs?: number } = {},
): Promise<{ alreadyCompleted: boolean }> {
  const { body } = await callWebhook<unknown>(
    DRIVE_EXPORT_WEBHOOK,
    { project_id: projectId, config: options.drive ?? driveConfigFromEnv() },
    { config: options.config, timeoutMs: options.timeoutMs ?? 15_000 },
  );
  const parsed = accepted.safeParse(body);
  if (!parsed.success) throw new N8nContractError("n8n drive-export returned an unexpected response");
  return { alreadyCompleted: "already_completed" in parsed.data };
}
