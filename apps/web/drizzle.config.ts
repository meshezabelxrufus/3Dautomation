import { defineConfig } from "drizzle-kit";

// Used for `drizzle-kit generate` (schema diff -> SQL). Migrations are applied by
// `src/db/migrate.ts` (pnpm db:migrate / the `migrate` Compose service).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
