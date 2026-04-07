import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../drizzle/schema.js";
import { createLogger } from "./_core/logger.js";

const log = createLogger("DB");

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export async function getDb() {
  if (db) return db;

  const url = process.env.DATABASE_URL;
  if (!url) {
    log.warn("DATABASE_URL not set — running without database");
    return null;
  }

  try {
    const pool = new pg.Pool({ connectionString: url, max: 20 });
    db = drizzle(pool, { schema });
    // Test connectivity
    await pool.query("SELECT 1");
    log.info("Connected to PostgreSQL");
    return db;
  } catch (err) {
    log.error("Failed to connect to PostgreSQL", { error: String(err) });
    return null;
  }
}

export type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
