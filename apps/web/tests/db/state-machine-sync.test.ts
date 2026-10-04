import { describe, expect, it } from "vitest";
import {
  allTransitionRows,
  CONCEPT_STATUSES,
  FINAL_DESIGN_STATUSES,
  PROJECT_EVENT_TYPES,
  PROJECT_STATUSES,
  REVISION_STATUSES,
  VIEW_STATUSES,
  VIEW_TYPES,
} from "@/server/domain/workflow-states";
import { connectTestDb } from "../setup/test-db";

const { pool } = connectTestDb();

const key = (r: { entity: string; from: string; to: string }) => `${r.entity}:${r.from}->${r.to}`;

describe("TypeScript state machine <-> database stay in sync", () => {
  it("workflow_status_transitions equals the TypeScript transition map", async () => {
    const { rows } = await pool.query<{ entity: string; from: string; to: string }>(
      `select entity::text as entity, from_status as "from", to_status as "to" from workflow_status_transitions`,
    );
    expect(rows.map(key).sort()).toEqual(allTransitionRows().map(key).sort());
  });

  it.each([
    ["project_status", PROJECT_STATUSES],
    ["concept_status", CONCEPT_STATUSES],
    ["revision_status", REVISION_STATUSES],
    ["final_design_status", FINAL_DESIGN_STATUSES],
    ["view_status", VIEW_STATUSES],
    ["view_type", VIEW_TYPES],
    ["project_event_type", PROJECT_EVENT_TYPES],
  ] as const)("enum %s matches the TypeScript values", async (enumName, values) => {
    const { rows } = await pool.query<{ v: string }>(
      `select unnest(enum_range(null::"${enumName}"))::text as v`,
    );
    expect(rows.map((r) => r.v)).toEqual([...values]);
  });
});
