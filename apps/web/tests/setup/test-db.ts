import { Pool } from "pg";
import { afterAll, inject } from "vitest";
import { createDb, type Database } from "@/db/client";

/** Per-file connection to the migrated test database (see global-db.ts). */
export function connectTestDb(): { db: Database; pool: Pool } {
  const pool = new Pool({ connectionString: inject("databaseUrl"), max: 5 });
  afterAll(() => pool.end());
  return { db: createDb(pool), pool };
}

type PgError = { code?: string; constraint?: string; message?: string };

/** Unwraps drizzle's DrizzleQueryError to the underlying pg error. */
export function pgError(err: unknown): PgError {
  return ((err as { cause?: unknown })?.cause ?? err) as PgError;
}

/** Asserts that `promise` rejects with the given Postgres error code (and constraint). */
export async function expectPgError(
  promise: Promise<unknown>,
  expected: { code: string; constraint?: string },
): Promise<PgError> {
  try {
    await promise;
  } catch (err) {
    const pg = pgError(err);
    if (pg.code !== expected.code || (expected.constraint && pg.constraint !== expected.constraint)) {
      throw new Error(
        `expected pg error ${expected.code}/${expected.constraint ?? "*"}, got ${pg.code}/${pg.constraint}: ${pg.message}`,
      );
    }
    return pg;
  }
  throw new Error(`expected pg error ${expected.code}, but the operation succeeded`);
}
