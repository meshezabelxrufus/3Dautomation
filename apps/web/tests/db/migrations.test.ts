import { inject, describe, expect, it } from "vitest";
import { runMigrations } from "@/db/migrate";
import { connectTestDb } from "../setup/test-db";

const { pool } = connectTestDb();

describe("migrations", () => {
  it("creates all workflow tables", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "concepts",
      "final_designs",
      "final_views",
      "project_events",
      "projects",
      "revisions",
      "workflow_status_transitions",
    ]);
  });

  it("records both migrations in the journal", async () => {
    const { rows } = await pool.query("select count(*)::int as n from drizzle.__drizzle_migrations");
    expect(rows[0].n).toBe(2);
  });

  it("is idempotent (re-running applies nothing and does not fail)", async () => {
    await runMigrations(inject("databaseUrl"));
    const { rows } = await pool.query("select count(*)::int as n from drizzle.__drizzle_migrations");
    expect(rows[0].n).toBe(2);
  });

  it("installs the workflow triggers", async () => {
    const { rows } = await pool.query<{ tgname: string }>(
      "select tgname from pg_trigger where not tgisinternal order by 1",
    );
    expect(rows.map((r) => r.tgname)).toHaveLength(14);
  });

  it("creates indexes on frequently queried columns", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'public'",
    );
    const names = rows.map((r) => r.indexname);
    for (const expected of [
      "projects_status_updated_at_idx",
      "concepts_project_status_idx",
      "final_views_one_current_per_type",
      "project_events_project_created_idx",
      "revisions_one_generating_per_concept",
      "final_designs_one_active_per_project",
    ]) {
      expect(names).toContain(expected);
    }
  });
});
