import "server-only";
import { Pool } from "pg";

// One pool per server process. In dev, hot reload re-evaluates modules,
// so the pool is cached on globalThis to avoid leaking connections.
const globalForDb = globalThis as unknown as { pgPool?: Pool };

export function getPool(): Pool {
  if (!globalForDb.pgPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    globalForDb.pgPool = new Pool({
      connectionString,
      max: 10,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 30_000,
    });
  }
  return globalForDb.pgPool;
}
