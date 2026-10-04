/**
 * Applies pending migrations from ./drizzle (journal kept in schema "drizzle").
 *
 *   pnpm --filter @three-d/web db:migrate        (host; needs DATABASE_URL, e.g. from .env.local)
 *   docker compose run --rm migrate              (runs automatically before `web` starts)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createDb } from "./client";

const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(createDb(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("db:migrate: DATABASE_URL is not set");
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log("db:migrate: migrations applied"))
    .catch((err: unknown) => {
      console.error("db:migrate: failed", err);
      process.exit(1);
    });
}
