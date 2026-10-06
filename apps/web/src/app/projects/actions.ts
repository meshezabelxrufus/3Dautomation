"use server";

import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { revalidatePath } from "next/cache";
import type { ViewType } from "@/server/domain/workflow-states";
import { VIEW_TYPES } from "@/server/domain/workflow-states";
import { getDb } from "@/lib/server/db";
import {
  createProjectSchema,
  fieldErrors,
  IDEA_COUNT_MAX,
  IDEA_COUNT_MIN,
  refinementSchema,
  uuidSchema,
  type CreateProjectFieldErrors,
} from "@/lib/validation/project";
import * as commands from "@/server/commands/projects";
import { isDatabaseUnavailable } from "@/server/http/responses";
import { N8nContractError, N8nRejectedError, N8nUnavailableError } from "@/server/n8n/errors";
import { InvalidStateTransitionError, NotFoundError, WorkflowGuardError } from "@/server/workflow/errors";
import { getProject } from "@/server/queries/projects";
import * as wf from "@/server/workflow/workflow";

export type ActionResult = { ok: true } | { ok: false; message: string };

export type CreateProjectState = {
  fields?: CreateProjectFieldErrors;
  message?: string;
  values?: { projectName: string; clientName: string; designBrief: string; ideaCount: string };
};

/** Turns workflow errors into short, client-facing messages. Unknown errors are rethrown. */
function toMessage(err: unknown): string {
  if (err instanceof InvalidStateTransitionError) {
    return "This project has moved on since you opened it. The latest state is shown now.";
  }
  if (err instanceof WorkflowGuardError) {
    return err.message.replace(/^workflow_guard_failed: /, "");
  }
  if (err instanceof NotFoundError) return "That item no longer exists.";
  if (err instanceof ZodError) return "That request wasn't valid. Reload the page and try again.";
  if (isDatabaseUnavailable(err)) {
    console.error("[db]", err instanceof Error ? err.message : err);
    return "The studio's database is temporarily unavailable. Nothing was changed. Please try again in a moment.";
  }
  if (err instanceof commands.RefinementRejectedError) return err.message;
  if (err instanceof commands.FinalizationRejectedError) return err.message;
  if (err instanceof N8nUnavailableError) {
    console.error("[n8n]", err.message);
    return "The studio's automation service didn't respond. Nothing was saved. Please try again in a moment.";
  }
  if (err instanceof N8nRejectedError) {
    if (err.code === "invalid_state") return "Concepts are already being generated, or the project has moved on. The latest state is shown now.";
    if (err.code === "image_in_progress") return "This image is already being generated.";
    if (err.code === "image_already_done") return "This concept already has its image. The latest state is shown now.";
    if (err.code === "no_base_image") return "This concept has no image to refine yet.";
    if (err.code === "views_in_progress") return "That view is already being generated.";
    if (err.code === "not_retryable") return "Only failed views can be generated again until all four are ready.";
    if (err.code === "nothing_to_do") return "There are no views to generate right now.";
    return "The request was rejected. Check the details and try again.";
  }
  if (err instanceof N8nContractError) {
    console.error("[n8n]", err.message);
    return "Something unexpected came back from the automation service. Please try again.";
  }
  throw err;
}

async function run(projectId: string | null, fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, message: toMessage(err) };
  } finally {
    revalidatePath("/projects");
    if (projectId) revalidatePath(`/projects/${projectId}`);
  }
}

const id = (value: string) => uuidSchema.parse(value);

/** Create Project form: validate, create, start generation, open the workspace. */
export async function createProjectAction(_prev: CreateProjectState, formData: FormData): Promise<CreateProjectState> {
  const values = {
    projectName: String(formData.get("projectName") ?? ""),
    clientName: String(formData.get("clientName") ?? ""),
    designBrief: String(formData.get("designBrief") ?? ""),
    ideaCount: String(formData.get("ideaCount") ?? "3"),
  };
  const parsed = createProjectSchema.safeParse(values);
  if (!parsed.success) return { fields: fieldErrors(parsed.error), values };

  let projectId: string;
  try {
    projectId = (await commands.createProjectAndGenerate(parsed.data)).projectId;
  } catch (err) {
    if (err instanceof N8nRejectedError && Object.keys(err.fields).length) {
      return { fields: err.fields as CreateProjectFieldErrors, values };
    }
    return { message: toMessage(err), values };
  }
  revalidatePath("/projects");
  redirect(`/projects/${projectId}`);
}

export async function generateIdeasAction(projectId: string, ideaCount: number): Promise<ActionResult> {
  const count = Math.min(IDEA_COUNT_MAX, Math.max(IDEA_COUNT_MIN, Math.round(ideaCount)));
  return run(projectId, () => commands.generateIdeas(id(projectId), count));
}

export async function selectConceptAction(projectId: string, conceptId: string): Promise<ActionResult> {
  return run(projectId, async () => {
    await commands.assertConceptInProject(getDb(), id(projectId), id(conceptId));
    return wf.selectConcept(getDb(), conceptId);
  });
}

/** Unselect a selected concept or restore a rejected one (back to READY). */
export async function restoreConceptAction(projectId: string, conceptId: string): Promise<ActionResult> {
  return run(projectId, async () => {
    await commands.assertConceptInProject(getDb(), id(projectId), id(conceptId));
    return wf.restoreConcept(getDb(), conceptId);
  });
}

/** Generate the image again for one concept whose image failed. */
export async function retryConceptImageAction(projectId: string, conceptId: string): Promise<ActionResult> {
  return run(projectId, async () => {
    await commands.assertConceptInProject(getDb(), id(projectId), id(conceptId));
    return commands.retryConceptImage(conceptId);
  });
}

export async function rejectConceptAction(projectId: string, conceptId: string): Promise<ActionResult> {
  return run(projectId, async () => {
    await commands.assertConceptInProject(getDb(), id(projectId), id(conceptId));
    return wf.rejectConcept(getDb(), conceptId);
  });
}

/**
 * Refine one concept. Carries the project, the concept and the version the client was looking at
 * (null = original); the database refuses the request if any of them doesn't match.
 */
export async function refineConceptAction(
  projectId: string,
  conceptId: string,
  baseRevisionId: string | null,
  feedback: string,
): Promise<ActionResult> {
  const parsed = refinementSchema.safeParse(feedback);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid feedback." };
  return run(projectId, () =>
    commands.refineConcept(getDb(), {
      projectId: id(projectId),
      conceptId: id(conceptId),
      baseRevisionId: baseRevisionId ? id(baseRevisionId) : null,
      feedback: parsed.data,
    }),
  );
}

/** Retry a failed refinement (same feedback, same base version). */
export async function retryRefinementAction(projectId: string, conceptId: string, revisionId: string): Promise<ActionResult> {
  return run(projectId, () =>
    commands.retryRefinement(getDb(), { projectId: id(projectId), conceptId: id(conceptId), revisionId: id(revisionId) }),
  );
}

/** "Use this version": make it the concept's current version and approve the concept. */
export async function chooseConceptVersionAction(projectId: string, conceptId: string, revisionId: string | null): Promise<ActionResult> {
  return run(projectId, () =>
    commands.useConceptVersion(getDb(), {
      projectId: id(projectId),
      conceptId: id(conceptId),
      revisionId: revisionId ? id(revisionId) : null,
    }),
  );
}

/**
 * FINALIZE DESIGN: the exact concept version (revisionId null = the original image) becomes the canonical
 * design, then the four views start. Safe to repeat (a duplicate request changes nothing).
 */
export async function finalizeDesignAction(
  projectId: string,
  conceptId: string,
  revisionId: string | null,
): Promise<ActionResult> {
  return run(projectId, () =>
    commands.finalizeDesign(getDb(), {
      projectId: id(projectId),
      conceptId: id(conceptId),
      revisionId: revisionId ? id(revisionId) : null,
    }),
  );
}

/** Start the views (if finalizing stalled) or retry every failed view. Successful views are never redone. */
export async function generateViewsAction(projectId: string): Promise<ActionResult> {
  return run(projectId, () => commands.generateViews(getDb(), id(projectId)));
}

export async function regenerateViewAction(projectId: string, viewType: ViewType): Promise<ActionResult> {
  if (!VIEW_TYPES.includes(viewType)) return { ok: false, message: "Unknown view." };
  return run(projectId, () => commands.regenerateView(getDb(), id(projectId), viewType));
}

export async function approveViewsAndDeliverAction(projectId: string): Promise<ActionResult> {
  return run(projectId, () => commands.approveViewsAndDeliver(getDb(), id(projectId)));
}

/** Start or resume the Google Drive upload (idempotent: nothing already in Drive is uploaded again). */
export async function deliverToDriveAction(projectId: string): Promise<ActionResult> {
  return run(projectId, () => commands.deliverToDrive(id(projectId)));
}

export async function retryProjectAction(projectId: string): Promise<ActionResult> {
  return run(projectId, async () => {
    const project = await getProject(getDb(), id(projectId));
    if (!project) throw new NotFoundError("project", projectId);
    // Concept generation is an n8n job: retrying means running it again.
    if (project.status === "FAILED" && project.failedFromStatus === "GENERATING_CONCEPTS") {
      return commands.generateIdeas(project.id, project.requestedConceptCount ?? 3);
    }
    return wf.retryProject(getDb(), project.id);
  });
}
