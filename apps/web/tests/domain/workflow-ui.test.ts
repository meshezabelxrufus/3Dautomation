import { describe, expect, it } from "vitest";
import { createProjectSchema } from "@/lib/validation/project";
import { progressFor, STATUS_META, stageFor, statusMeta, workspaceStateFor } from "@/lib/workflow-ui";
import { PROJECT_STATUSES } from "@/server/domain/workflow-states";

describe("workflow UI metadata", () => {
  it("describes every project status", () => {
    for (const s of PROJECT_STATUSES) {
      expect(STATUS_META[s].label.length).toBeGreaterThan(0);
      expect(STATUS_META[s].description.length).toBeGreaterThan(0);
      expect(workspaceStateFor(s)).toBeTruthy();
    }
  });

  it("marks exactly the backend-working statuses as busy (drives polling speed)", () => {
    const busy = PROJECT_STATUSES.filter((s) => statusMeta(s).busy);
    expect(busy).toEqual(["GENERATING_CONCEPTS", "REFINING", "FINALIZING", "GENERATING_VIEWS", "UPLOADING_TO_DRIVE"]);
  });

  it("maps statuses to the required workspace states", () => {
    expect(workspaceStateFor("DRAFT")).toBe("empty");
    expect(workspaceStateFor("GENERATING_CONCEPTS")).toBe("generating");
    expect(workspaceStateFor("CONCEPT_REVIEW")).toBe("concepts-ready");
    expect(workspaceStateFor("REFINING")).toBe("refining");
    expect(workspaceStateFor("FINALIZING")).toBe("finalizing");
    expect(workspaceStateFor("GENERATING_VIEWS")).toBe("generating-views");
    expect(workspaceStateFor("COMPLETED")).toBe("completed");
    expect(workspaceStateFor("FAILED")).toBe("error");
  });

  it("keeps a failed project on the stage that failed", () => {
    expect(stageFor("FAILED", "GENERATING_VIEWS")).toBe(stageFor("GENERATING_VIEWS"));
    expect(stageFor("FAILED", "UPLOADING_TO_DRIVE")).toBe(5);
    expect(progressFor("COMPLETED")).toBe(1);
    expect(progressFor("DRAFT")).toBe(0);
  });
});

describe("create project validation (shared by form and server)", () => {
  const valid = {
    projectName: "Wolf",
    clientName: "Acme",
    designBrief: "A futuristic mechanical wolf bust with geometric armor.",
    ideaCount: "4",
  };

  it("accepts a valid brief and coerces the idea count", () => {
    expect(createProjectSchema.parse(valid)).toMatchObject({ ideaCount: 4 });
  });

  it.each([
    [{ projectName: "  " }, "projectName"],
    [{ clientName: "" }, "clientName"],
    [{ designBrief: "too short" }, "designBrief"],
    [{ designBrief: "x".repeat(4001) }, "designBrief"],
    [{ ideaCount: "9" }, "ideaCount"],
  ])("rejects %o", (patch, field) => {
    const result = createProjectSchema.safeParse({ ...valid, ...patch });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path[0]).toBe(field);
  });
});
