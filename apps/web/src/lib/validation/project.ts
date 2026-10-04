import { z } from "zod";

export const IDEA_COUNT_MIN = 2;
export const IDEA_COUNT_MAX = 5;
export const BRIEF_MIN = 20;
export const BRIEF_MAX = 4000;

/** Shared by the Create Project form (inline validation) and the server (authoritative). */
export const createProjectSchema = z.object({
  projectName: z.string().trim().min(1, "Give the project a name.").max(200, "Keep the name under 200 characters."),
  clientName: z.string().trim().min(1, "Who is this for?").max(200, "Keep the client name under 200 characters."),
  designBrief: z
    .string()
    .trim()
    .min(BRIEF_MIN, `Describe the idea in at least ${BRIEF_MIN} characters, so there's something to design from.`)
    .max(BRIEF_MAX, `Keep the brief under ${BRIEF_MAX} characters.`),
  ideaCount: z.coerce.number().int().min(IDEA_COUNT_MIN).max(IDEA_COUNT_MAX).default(3),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateProjectFieldErrors = Partial<Record<keyof CreateProjectInput, string>>;

export function fieldErrors(error: z.ZodError): CreateProjectFieldErrors {
  const out: CreateProjectFieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path[0] as keyof CreateProjectInput | undefined;
    if (key && !out[key]) out[key] = issue.message;
  }
  return out;
}

export const uuidSchema = z.uuid();
export const refinementSchema = z
  .string()
  .trim()
  .min(3, "Describe what should change.")
  .max(1000, "Keep feedback under 1000 characters.");
