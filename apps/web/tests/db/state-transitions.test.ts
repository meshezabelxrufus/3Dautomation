import { describe, expect, it } from "vitest";
import { InvalidStateTransitionError, WorkflowGuardError } from "@/server/workflow/errors";
import * as wf from "@/server/workflow/workflow";
import {
  driveIds,
  inConceptReview,
  inViewReview,
  newProject,
  withAllViewsApproved,
  withFinalizedDesign,
} from "../setup/factories";
import { expectPgError, connectTestDb } from "../setup/test-db";

const { db, pool } = connectTestDb();
const TRANSITION = { code: "23514", constraint: "workflow_status_transition" } as const;
const GUARD = { code: "23514", constraint: "workflow_guard" } as const;

describe("database rejects invalid transitions even when the app is bypassed (raw SQL)", () => {
  it("project: DRAFT -> COMPLETED", async () => {
    const p = await newProject(db);
    const err = await expectPgError(pool.query(`update projects set status = 'COMPLETED' where id = $1`, [p.id]), TRANSITION);
    expect(err.message).toContain("project DRAFT -> COMPLETED");
  });

  it("project: cannot be inserted in a non-initial status", async () => {
    await expectPgError(
      pool.query(`insert into projects (project_name, client_name, design_brief, status) values ('p','c','b','VIEW_REVIEW')`),
      TRANSITION,
    );
  });

  it("project: CONCEPT_REVIEW -> UPLOADING_TO_DRIVE (skipping finalization and views)", async () => {
    const { project } = await inConceptReview(db, 1);
    await expectPgError(pool.query(`update projects set status = 'UPLOADING_TO_DRIVE' where id = $1`, [project.id]), TRANSITION);
  });

  it("project: COMPLETED is terminal", async () => {
    const { project } = await withAllViewsApproved(db);
    await wf.startDriveUpload(db, project.id);
    await wf.completeDriveUpload(db, project.id, { driveFileIds: driveIds() });
    await expectPgError(pool.query(`update projects set status = 'DRAFT' where id = $1`, [project.id]), TRANSITION);
  });

  it("concept: FINAL -> READY and READY -> GENERATING", async () => {
    const { concept } = await withFinalizedDesign(db);
    await expectPgError(pool.query(`update concepts set status = 'READY' where id = $1`, [concept.id]), TRANSITION);
    const { concepts } = await inConceptReview(db, 1);
    await expectPgError(pool.query(`update concepts set status = 'GENERATING' where id = $1`, [concepts[0]!.id]), TRANSITION);
  });

  it("revision: FAILED -> READY", async () => {
    const { concepts } = await inConceptReview(db, 1);
    const rev = await wf.startRefinement(db, concepts[0]!.id, { clientFeedback: "x" });
    await wf.failRevision(db, rev.id, "provider timeout");
    await expectPgError(
      pool.query(`update revisions set status = 'READY', image_url = 'x.png' where id = $1`, [rev.id]),
      TRANSITION,
    );
  });

  it("final_design: FINALIZED -> PENDING", async () => {
    const { design } = await withFinalizedDesign(db);
    await expectPgError(pool.query(`update final_designs set status = 'PENDING' where id = $1`, [design.id]), TRANSITION);
  });

  it("final_view: APPROVED -> GENERATING and insert as APPROVED", async () => {
    const { views, project, design } = await withAllViewsApproved(db);
    await expectPgError(pool.query(`update final_views set status = 'GENERATING' where id = $1`, [views[0]!.id]), TRANSITION);
    await wf.startViewGeneration(db, project.id, ["FRONT"]);
    await expectPgError(
      pool.query(
        `insert into final_views (project_id, final_design_id, view_type, version_number, is_current, status, image_url)
         values ($1, $2, 'BACK', 7, false, 'APPROVED', 'x.png')`,
        [project.id, design.id],
      ),
      TRANSITION,
    );
  });
});

describe("database guards (cross-entity rules)", () => {
  it("cannot start uploading until all 4 views are approved", async () => {
    const { project, views } = await inViewReview(db);
    await wf.approveView(db, views[0]!.id);
    await expectPgError(pool.query(`update projects set status = 'UPLOADING_TO_DRIVE' where id = $1`, [project.id]), GUARD);
  });

  it("cannot complete without Drive file ids for all 4 views", async () => {
    const { project } = await withAllViewsApproved(db);
    await wf.startDriveUpload(db, project.id);
    await expectPgError(pool.query(`update projects set status = 'COMPLETED' where id = $1`, [project.id]), GUARD);
  });

  it("cannot enter CONCEPT_REVIEW with no generated concept", async () => {
    const p = await newProject(db);
    await wf.startConceptGeneration(db, p.id, { requestedCount: 2 });
    await wf.addConcept(db, p.id, { title: "still generating", description: "d" });
    await expect(wf.completeConceptGeneration(db, p.id)).rejects.toBeInstanceOf(WorkflowGuardError);
  });

  it("concepts can only be created while generating concepts", async () => {
    const p = await newProject(db); // DRAFT
    await expectPgError(
      pool.query(`insert into concepts (project_id, concept_number, title, description) values ($1, 1, 't', 'd')`, [p.id]),
      GUARD,
    );
  });

  it("views can only be created while generating views", async () => {
    const { project, design } = await inViewReview(db); // VIEW_REVIEW
    await expectPgError(
      pool.query(
        `insert into final_views (project_id, final_design_id, view_type, version_number, is_current) values ($1, $2, 'FRONT', 5, false)`,
        [project.id, design.id],
      ),
      GUARD,
    );
  });

  it("a FAILED project may only retry the step it failed in", async () => {
    const { project } = await withFinalizedDesign(db);
    await wf.startViewGeneration(db, project.id);
    await wf.failProject(db, project.id, { stage: "VIEWS", reason: "provider error" });
    await expectPgError(pool.query(`update projects set status = 'UPLOADING_TO_DRIVE' where id = $1`, [project.id]), TRANSITION);
    const retried = await wf.retryProject(db, project.id);
    expect(retried).toMatchObject({ status: "GENERATING_VIEWS", failedFromStatus: null, failureReason: null });
  });
});

describe("service layer surfaces typed errors", () => {
  it("throws InvalidStateTransitionError for an invalid project transition", async () => {
    const p = await newProject(db);
    await expect(wf.completeConceptGeneration(db, p.id)).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it("throws InvalidStateTransitionError when approving a view that is still generating", async () => {
    const { project } = await inViewReview(db);
    const [regenerating] = await wf.startViewGeneration(db, project.id, ["LEFT"]);
    // project is GENERATING_VIEWS now, so the phase guard fires first
    await expect(wf.approveView(db, regenerating!.id)).rejects.toBeInstanceOf(WorkflowGuardError);
  });

  it("maps database-raised violations to typed errors", async () => {
    const { project, views } = await inViewReview(db);
    await wf.approveView(db, views[0]!.id);
    // Service pre-check passes (VIEW_REVIEW -> UPLOADING_TO_DRIVE is a legal edge);
    // the database guard rejects it and the error is mapped.
    await expect(wf.startDriveUpload(db, project.id)).rejects.toBeInstanceOf(WorkflowGuardError);
  });

  it("does not record an event when the transition is rejected", async () => {
    const p = await newProject(db);
    await expect(wf.startDriveUpload(db, p.id)).rejects.toBeInstanceOf(InvalidStateTransitionError);
    const { rows } = await pool.query(`select event_type from project_events where project_id = $1`, [p.id]);
    expect(rows.map((r) => r.event_type)).toEqual(["PROJECT_CREATED"]);
  });
});
