import { describe, expect, it } from "vitest";
import {
  allTransitionRows,
  assertTransition,
  canTransition,
  InvalidStateTransitionError,
  NEW_ROW,
  PROJECT_MACHINE,
  PROJECT_STATUSES,
  STATE_MACHINES,
  WORKFLOW_ENTITIES,
} from "@/server/domain/workflow-states";

describe("workflow state machines (pure)", () => {
  it("allows the happy path for projects", () => {
    const path = [
      "DRAFT",
      "GENERATING_CONCEPTS",
      "CONCEPT_REVIEW",
      "REFINING",
      "CONCEPT_REVIEW",
      "FINALIZING",
      "GENERATING_VIEWS",
      "VIEW_REVIEW",
      "UPLOADING_TO_DRIVE",
      "COMPLETED",
    ];
    for (let i = 1; i < path.length; i++) {
      expect(canTransition("project", path[i - 1]!, path[i]!), `${path[i - 1]} -> ${path[i]}`).toBe(true);
    }
  });

  it.each([
    ["project", "DRAFT", "COMPLETED"],
    ["project", "DRAFT", "CONCEPT_REVIEW"],
    ["project", "COMPLETED", "DRAFT"],
    ["project", "CONCEPT_REVIEW", "UPLOADING_TO_DRIVE"],
    ["project", "REFINING", "FAILED"],
    ["concept", "FINAL", "READY"],
    ["concept", "REJECTED", "SELECTED"],
    ["revision", "FAILED", "READY"],
    ["final_view", "APPROVED", "GENERATING"],
    ["final_design", "FINALIZED", "PENDING"],
  ] as const)("rejects %s %s -> %s", (entity, from, to) => {
    expect(canTransition(entity, from, to)).toBe(false);
    expect(() => assertTransition(entity, from, to)).toThrow(InvalidStateTransitionError);
  });

  it("only allows DRAFT as the initial project status", () => {
    expect(canTransition("project", NEW_ROW, "DRAFT")).toBe(true);
    for (const s of PROJECT_STATUSES.filter((s) => s !== "DRAFT")) {
      expect(canTransition("project", NEW_ROW, s)).toBe(false);
    }
  });

  it("COMPLETED is terminal", () => {
    expect(PROJECT_MACHINE.transitions.COMPLETED).toBeUndefined();
  });

  it("every transition target is a known status of its entity", () => {
    for (const entity of WORKFLOW_ENTITIES) {
      const machine = STATE_MACHINES[entity];
      const known = new Set<string>([...machine.initial, ...Object.keys(machine.transitions)]);
      for (const targets of Object.values(machine.transitions)) for (const t of targets ?? []) known.add(t);
      for (const row of allTransitionRows().filter((r) => r.entity === entity)) {
        expect(known.has(row.to)).toBe(true);
      }
    }
  });
});
