/**
 * Creates a throwaway database for the test run, owned by the app role and migrated
 * with the real migrations (as the app role, exactly like production), then drops it.
 *
 * Connection settings come from the repo-root .env (same values Docker Compose uses):
 * Postgres must be running (`docker compose up -d postgres`).
 * Override with TEST_DATABASE_ADMIN_URL / TEST_DATABASE_HOST / TEST_DATABASE_PORT if needed.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../../src/db/migrate";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`tests: ${name} is not set (expected in the repo-root .env)`);
  return value;
}

export default async function setup(project: TestProject) {
  const rootEnv = path.resolve(__dirname, "../../../../.env");
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

  const host = process.env.TEST_DATABASE_HOST ?? "localhost";
  const port = process.env.TEST_DATABASE_PORT ?? process.env.POSTGRES_HOST_PORT ?? "5434";
  const adminUrl =
    process.env.TEST_DATABASE_ADMIN_URL ??
    `postgres://${encodeURIComponent(required("POSTGRES_USER"))}:${encodeURIComponent(required("POSTGRES_PASSWORD"))}@${host}:${port}/postgres`;
  const appUser = required("APP_DB_USER");
  const appPassword = required("APP_DB_PASSWORD");

  const dbName = `app_test_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${appUser}"`);
  await admin.end();

  const databaseUrl = `postgres://${encodeURIComponent(appUser)}:${encodeURIComponent(appPassword)}@${host}:${port}/${dbName}`;
  await runMigrations(databaseUrl);
  project.provide("databaseUrl", databaseUrl);

  return async () => {
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await cleanup.end();
  };
}
