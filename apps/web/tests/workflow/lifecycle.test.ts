import { describe, expect, it } from "vitest";
import { listEvents } from "@/server/workflow/events";
import * as wf from "@/server/workflow/workflow";
import { driveIds, img, inConceptReview, newProject, withFinalizedDesign } from "../setup/factories";
import { connectTestDb } from "../setup/test-db";

const { db } = connectTestDb();

describe("full Milestone 1 lifecycle (no AI: images are placeholders)", () => {
  it("brief -> concepts -> refine -> finalize -> 4 views -> Drive -> COMPLETED, with events", async () => {
    const project = await newProject(db);
    expect(project.status).toBe("DRAFT");

    await wf.startConceptGeneration(db, project.id, { requestedCount: 3 });
    const c1 = await wf.addConcept(db, project.id, { title: "Orbit", description: "ring arm" });
    const c2 = await wf.addConcept(db, project.id, { title: "Arc", description: "arched arm" });
    const c3 = await wf.addConcept(db, project.id, { title: "Stack", description: "stacked discs" });
    await wf.markConceptGenerated(db, c1.id, { imageUrl: img("c1") });
    await wf.markConceptGenerated(db, c2.id, { imageUrl: img("c2") });
    await wf.markConceptFailed(db, c3.id, "safety filter");
    expect((await wf.completeConceptGeneration(db, project.id)).status).toBe("CONCEPT_REVIEW");

    await wf.rejectConcept(db, c2.id, "too plain");
    await wf.selectConcept(db, c1.id);

    const rev = await wf.startRefinement(db, c1.id, { clientFeedback: "make the ring thinner, matte black" });
    expect((await wf.getProject(db, project.id))!.status).toBe("REFINING");
    await wf.completeRevision(db, rev.id, {
      imageUrl: img("rev1"),
      interpretedInstruction: { changes: ["ring thinner"], preserve: ["base"] },
      generationPrompt: "edit",
    });
    expect((await wf.getProject(db, project.id))!.status).toBe("CONCEPT_REVIEW");

    const pending = await wf.beginFinalization(db, project.id, { conceptId: c1.id, revisionId: rev.id });
    expect(pending.masterImage).toContain("rev1");
    expect((await wf.getProject(db, project.id))!.status).toBe("FINALIZING");
    await wf.confirmFinalization(db, pending.id);

    const started = await wf.startViewGeneration(db, project.id);
    expect(started).toHaveLength(4);
    for (const v of started) await wf.recordViewGenerated(db, v.id, { imageUrl: img(v.viewType) });
    await wf.completeViewGeneration(db, project.id);

    // Client asks to regenerate the LEFT view once.
    const [left2] = await wf.startViewGeneration(db, project.id, ["LEFT"]);
    expect(left2).toMatchObject({ viewType: "LEFT", versionNumber: 2, isCurrent: true });
    await wf.recordViewGenerated(db, left2!.id, { imageUrl: img("LEFT-v2") });
    await wf.completeViewGeneration(db, project.id);

    for (const v of await wf.listCurrentViews(db, project.id)) await wf.approveView(db, v.id);
    await wf.startDriveUpload(db, project.id);
    const done = await wf.completeDriveUpload(db, project.id, { driveFileIds: driveIds(), driveFolderId: "folder-1" });

    expect(done.status).toBe("COMPLETED");
    expect(done.finalizedAt).toBeInstanceOf(Date);

    const concepts = await wf.listConcepts(db, project.id);
    expect(concepts.map((c) => c.status)).toEqual(["FINAL", "REJECTED", "FAILED"]);
    const [revision] = await wf.listRevisions(db, [c1.id]);
    expect(revision!.status).toBe("SELECTED");
    const views = await wf.listCurrentViews(db, project.id);
    expect(views.every((v) => v.status === "APPROVED" && v.driveFileId)).toBe(true);

    const events = (await listEvents(db, project.id)).map((e) => e.eventType);
    expect(events).toEqual([
      "PROJECT_CREATED",
      "CONCEPT_GENERATION_STARTED",
      "GENERATION_FAILED",
      "CONCEPT_GENERATION_COMPLETED",
      "CONCEPT_REJECTED",
      "CONCEPT_SELECTED",
      "REFINEMENT_STARTED",
      "REVISION_CREATED",
      "DESIGN_FINALIZED",
      "VIEW_GENERATION_STARTED",
      "VIEW_GENERATED",
      "VIEW_GENERATED",
      "VIEW_GENERATED",
      "VIEW_GENERATED",
      "VIEW_GENERATION_STARTED",
      "VIEW_GENERATED",
      "VIEW_APPROVED",
      "VIEW_APPROVED",
      "VIEW_APPROVED",
      "VIEW_APPROVED",
      "DRIVE_UPLOAD_STARTED",
      "DRIVE_UPLOAD_COMPLETED",
      "PROJECT_COMPLETED",
    ]);
  });

  it("a failed refinement returns the project to CONCEPT_REVIEW and logs GENERATION_FAILED", async () => {
    const { project, concepts } = await inConceptReview(db, 1);
    const rev = await wf.startRefinement(db, concepts[0]!.id, { clientFeedback: "add a shade" });
    await wf.failRevision(db, rev.id, "timeout");
    expect((await wf.getProject(db, project.id))!.status).toBe("CONCEPT_REVIEW");
    expect((await wf.listConcepts(db, project.id))[0]!.status).toBe("READY");
    const last = (await listEvents(db, project.id)).at(-1)!;
    expect(last).toMatchObject({ eventType: "GENERATION_FAILED", payload: { stage: "REFINEMENT", reason: "timeout" } });
  });

  it("a failed Drive upload can be retried to completion", async () => {
    const { project } = await withFinalizedDesign(db);
    for (const v of await wf.startViewGeneration(db, project.id)) {
      await wf.recordViewGenerated(db, v.id, { imageUrl: img(v.viewType) });
    }
    await wf.completeViewGeneration(db, project.id);
    for (const v of await wf.listCurrentViews(db, project.id)) await wf.approveView(db, v.id);
    await wf.startDriveUpload(db, project.id);

    const failed = await wf.failProject(db, project.id, { stage: "DRIVE_UPLOAD", reason: "token expired" });
    expect(failed).toMatchObject({ status: "FAILED", failedFromStatus: "UPLOADING_TO_DRIVE", failureReason: "token expired" });

    await wf.retryProject(db, project.id);
    const done = await wf.completeDriveUpload(db, project.id, { driveFileIds: driveIds() });
    expect(done.status).toBe("COMPLETED");
    const events = (await listEvents(db, project.id)).map((e) => e.eventType);
    expect(events.slice(-5)).toEqual([
      "DRIVE_UPLOAD_STARTED",
      "GENERATION_FAILED",
      "DRIVE_UPLOAD_STARTED",
      "DRIVE_UPLOAD_COMPLETED",
      "PROJECT_COMPLETED",
    ]);
  });

  it("generating more concepts continues the numbering", async () => {
    const { project } = await inConceptReview(db, 2);
    await wf.startConceptGeneration(db, project.id, { requestedCount: 2 });
    const c = await wf.addConcept(db, project.id, { title: "more", description: "d", imageUrl: img("more") });
    expect(c.conceptNumber).toBe(3);
  });

  it("cancelling finalization returns to concept review and allows a new final design", async () => {
    const { project, concepts } = await inConceptReview(db, 2);
    const first = await wf.beginFinalization(db, project.id, { conceptId: concepts[0]!.id });
    await wf.cancelFinalization(db, first.id);
    expect((await wf.getProject(db, project.id))!.status).toBe("CONCEPT_REVIEW");
    const second = await wf.beginFinalization(db, project.id, { conceptId: concepts[1]!.id });
    expect(second.status).toBe("PENDING");
  });

  it("project state is read from the database, not from client flags", async () => {
    const project = await newProject(db);
    await wf.startConceptGeneration(db, project.id, { requestedCount: 1 });
    // A second "start" (e.g. double click / duplicate request) is rejected by the state machine.
    await expect(wf.startConceptGeneration(db, project.id, { requestedCount: 1 })).rejects.toThrow(
      /invalid_state_transition: project GENERATING_CONCEPTS -> GENERATING_CONCEPTS/,
    );
  });
});
