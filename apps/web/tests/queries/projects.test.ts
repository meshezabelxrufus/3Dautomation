import { describe, expect, it } from "vitest";
import * as q from "@/server/queries/projects";
import * as wf from "@/server/workflow/workflow";
import { createProjectAndGenerate } from "@/server/commands/projects";
import { img, inConceptReview, inViewReview, newProject } from "../setup/factories";
import { connectTestDb } from "../setup/test-db";

const { db } = connectTestDb();

describe("read models used by the UI and GET API", () => {
  it("createProjectAndGenerate creates the project in GENERATING_CONCEPTS with the requested count", async () => {
    const p = await createProjectAndGenerate(db, {
      projectName: "Q",
      clientName: "C",
      designBrief: "A detailed enough design brief here.",
      ideaCount: 4,
    });
    const dto = await q.getProject(db, p.id);
    expect(dto).toMatchObject({ status: "GENERATING_CONCEPTS", requestedConceptCount: 4, conceptCount: 0 });
  });

  it("returns ISO date strings and null for unknown ids", async () => {
    const p = await newProject(db);
    const dto = await q.getProject(db, p.id);
    expect(dto?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await q.getProject(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await q.getProjectStatus(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("status changeToken changes when a concept image arrives (even if the project row does not change)", async () => {
    const p = await newProject(db);
    await wf.startConceptGeneration(db, p.id, { requestedCount: 2 });
    const c = await wf.addConcept(db, p.id, { title: "t", description: "d" });
    const before = await q.getProjectStatus(db, p.id);
    expect(before).toMatchObject({ status: "GENERATING_CONCEPTS", isBusy: true });

    await new Promise((r) => setTimeout(r, 5));
    await wf.markConceptGenerated(db, c.id, { imageUrl: img("c") });
    const after = await q.getProjectStatus(db, p.id);
    expect(after!.status).toBe(before!.status);
    expect(after!.changeToken).not.toBe(before!.changeToken);
  });

  it("status changeToken is stable when nothing changed", async () => {
    const p = await newProject(db);
    const a = await q.getProjectStatus(db, p.id);
    const b = await q.getProjectStatus(db, p.id);
    expect(a!.changeToken).toBe(b!.changeToken);
    expect(a!.isBusy).toBe(false);
  });

  it("lists projects with a cover image and concept count, newest first", async () => {
    const { project } = await inConceptReview(db, 2);
    const list = await q.listProjects(db);
    const item = list.find((p) => p.id === project.id)!;
    expect(item.conceptCount).toBe(2);
    expect(item.coverImageUrl).toMatch(/concept-1/);
    expect(list[0]!.updatedAt >= list[list.length - 1]!.updatedAt).toBe(true);
  });

  it("summarises revisions and returns views in FRONT/BACK/LEFT/RIGHT order", async () => {
    const { project, concepts } = await inConceptReview(db, 1);
    const rev = await wf.startRefinement(db, concepts[0]!.id, { clientFeedback: "thinner" });
    await wf.completeRevision(db, rev.id, {
      imageUrl: img("r"),
      interpretedInstruction: { changes: ["Arm -30%"], preserve: ["Base"] },
      generationPrompt: "p",
    });
    const revisions = await q.getRevisions(db, project.id);
    expect(revisions[0]).toMatchObject({ revisionNumber: 1, status: "READY", interpretationSummary: ["Arm -30%"] });

    const viewsProject = await inViewReview(db);
    const fv = await q.getFinalViews(db, viewsProject.project.id);
    expect(fv.finalDesign?.status).toBe("FINALIZED");
    expect(fv.views.map((v) => v.viewType)).toEqual(["FRONT", "BACK", "LEFT", "RIGHT"]);
  });
});

describe("studio summary (welcome page)", () => {
  it("classifies statuses and picks the newest unfinished project to continue", () => {
    const s = q.summarizeStatuses([
      { id: "a", status: "COMPLETED" },
      { id: "b", status: "GENERATING_VIEWS" },
      { id: "c", status: "CONCEPT_REVIEW" },
      { id: "d", status: "FAILED" },
      { id: "e", status: "DRAFT" },
      { id: "f", status: "COMPLETED" },
    ]);
    expect(s).toEqual({ total: 6, needsReview: 2, inProgress: 1, delivered: 2, continueId: "b" });
    expect(q.summarizeStatuses([]).continueId).toBeNull();
  });

  it("returns a consistent summary from the database", async () => {
    await inConceptReview(db, 1);
    const s = await q.getStudioSummary(db);
    expect(s.total).toBeGreaterThan(0);
    expect(s.needsReview + s.inProgress + s.delivered).toBeLessThanOrEqual(s.total);
    expect(s.continueWith === null || s.continueWith.status !== "COMPLETED").toBe(true);
  });
});
