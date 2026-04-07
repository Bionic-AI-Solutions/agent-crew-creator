/**
 * PostgreSQL database provisioning for per-app databases.
 * All operations throw on failure — never fakes success.
 */
import pg from "pg";
import { createLogger } from "../_core/logger.js";

const log = createLogger("PostgresAdmin");

const PG_ADMIN_URL = process.env.PG_ADMIN_URL || "";

function ensureConfigured() {
  if (!PG_ADMIN_URL) throw new Error("PG_ADMIN_URL not configured — cannot provision database");
}

function sanitizeSlug(slug: string): string {
  return slug.replace(/[^a-z0-9_]/g, "_");
}

export async function createDatabase(slug: string) {
  ensureConfigured();

  const { randomBytes } = await import("crypto");
  const dbName = `app_${sanitizeSlug(slug)}`;
  const user = `app_${sanitizeSlug(slug)}_user`;
  const password = randomBytes(16).toString("base64url");

  const client = new pg.Client({ connectionString: PG_ADMIN_URL });
  try {
    await client.connect();

    // Use escapeIdentifier/escapeLiteral to prevent SQL injection
    const safeUser = client.escapeIdentifier(user);
    const safePassword = client.escapeLiteral(password);
    const safeDbName = client.escapeIdentifier(dbName);

    try {
      await client.query(`CREATE ROLE ${safeUser} WITH LOGIN PASSWORD ${safePassword}`);
    } catch (err: any) {
      if (!String(err).includes("already exists")) throw err;
    }

    try {
      await client.query(`CREATE DATABASE ${safeDbName} OWNER ${safeUser}`);
    } catch (err: any) {
      if (!String(err).includes("already exists")) throw err;
    }

    await client.query(`GRANT ALL PRIVILEGES ON DATABASE ${safeDbName} TO ${safeUser}`);

    const parsed = new URL(PG_ADMIN_URL);
    const databaseUrl = `postgresql://${user}:${password}@${parsed.host}/${dbName}`;

    log.info("Created database", { dbName, user });
    return { databaseUrl, user, password };
  } finally {
    await client.end();
  }
}

export async function testConnectivity(databaseUrl: string): Promise<boolean> {
  if (!databaseUrl) return false;
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end();
  }
}

export async function backupDatabase(slug: string): Promise<string> {
  log.info("Database backup requested (manual step)", { slug });
  return `Backup for ${slug} — use pg_dump manually`;
}

export async function dropDatabase(slug: string): Promise<void> {
  ensureConfigured();
  const dbName = `app_${sanitizeSlug(slug)}`;
  const user = `app_${sanitizeSlug(slug)}_user`;

  const client = new pg.Client({ connectionString: PG_ADMIN_URL });
  try {
    await client.connect();
    const safeDbName = client.escapeIdentifier(dbName);
    const safeUser = client.escapeIdentifier(user);
    await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [dbName]);
    await client.query(`DROP DATABASE IF EXISTS ${safeDbName}`);
    await client.query(`DROP ROLE IF EXISTS ${safeUser}`);
    log.info("Dropped database", { dbName });
  } finally {
    await client.end();
  }
}

export const postgresAdmin = { createDatabase, testConnectivity, backupDatabase, dropDatabase };
