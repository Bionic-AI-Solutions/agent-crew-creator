/**
 * Langfuse project management via direct PostgreSQL access.
 *
 * Langfuse v3 has no public REST API for project creation, so we insert
 * directly into the Langfuse database to create projects and API keys
 * under the "Bionic AI Solutions" organization.
 */
import pg from "pg";
import { randomBytes, createHash } from "crypto";
import bcrypt from "bcryptjs";
import { createLogger } from "../_core/logger.js";

const log = createLogger("LangfuseAdmin");

const LANGFUSE_DB_PASSWORD = process.env.LANGFUSE_ADMIN_PASSWORD || "";
const LANGFUSE_DB_HOST = process.env.LANGFUSE_DB_HOST || "pg-ceph-rw.pg.svc.cluster.local";
const LANGFUSE_DB_NAME = "langfuse";
const LANGFUSE_DB_USER = "langfuse";
const LANGFUSE_ORG_ID = process.env.LANGFUSE_ORG_ID || "cmi7vys0y0001wd07fwx9grvn";
// Must match Langfuse server's SALT env var; without it fast-hash lookups
// produce a value that won't match Langfuse's lookup, so auth always fails.
const LANGFUSE_SALT = process.env.LANGFUSE_SALT || "";

function isConfigured(): boolean {
  return Boolean(LANGFUSE_DB_PASSWORD);
}

function getConnectionUrl(): string {
  return `postgresql://${LANGFUSE_DB_USER}:${LANGFUSE_DB_PASSWORD}@${LANGFUSE_DB_HOST}:5432/${LANGFUSE_DB_NAME}`;
}

function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(8).toString("hex").slice(0, 12);
  return `cm${timestamp}${random}`;
}

// Mirrors Langfuse's createShaHash from packages/shared/src/server/auth/apiKeys.ts:
// sha256(secretKey).update( sha256(SALT).digest("hex") ).digest("hex").
// LANGFUSE_SALT must match the SALT env var on the Langfuse web pod.
function fastHash(secretKey: string): string {
  if (!LANGFUSE_SALT) {
    throw new Error("LANGFUSE_SALT not set — required to compute fast_hashed_secret_key");
  }
  return createHash("sha256")
    .update(secretKey)
    .update(createHash("sha256").update(LANGFUSE_SALT, "utf8").digest("hex"))
    .digest("hex");
}

export async function createProject(slug: string) {
  if (!isConfigured()) {
    log.error("Langfuse admin not configured — LANGFUSE_ADMIN_PASSWORD not set");
    throw new Error("Langfuse admin not configured");
  }

  const client = new pg.Client({ connectionString: getConnectionUrl() });
  await client.connect();

  try {
    const projectId = generateId();
    const now = new Date();

    // Create project under Bionic AI Solutions org
    await client.query(
      `INSERT INTO projects (id, name, org_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [projectId, slug, LANGFUSE_ORG_ID, now, now],
    );

    log.info("Created Langfuse project", { projectId, name: slug, org: LANGFUSE_ORG_ID });

    // Generate API key pair. Langfuse stores TWO hashes for the secret:
    //   hashed_secret_key       — bcrypt(sk, 11), used for slow auth verify
    //   fast_hashed_secret_key  — sha256(sk + sha256(SALT)), used for fast lookups
    // (see Langfuse packages/shared/src/server/auth/apiKeys.ts).
    // Storing sha256 in both fields produces 401 on every API call.
    const apiKeyId = generateId();
    const publicKey = `pk-lf-${randomBytes(16).toString("hex")}`;
    const secretKey = `sk-lf-${randomBytes(16).toString("hex")}`;
    const hashedSecret = await bcrypt.hash(secretKey, 11);
    const fastHashedSecret = fastHash(secretKey);
    const displaySecret = `sk-lf-...${secretKey.slice(-4)}`;

    await client.query(
      `INSERT INTO api_keys (id, public_key, hashed_secret_key, fast_hashed_secret_key, display_secret_key, note, project_id, scope, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PROJECT', $8)`,
      [apiKeyId, publicKey, hashedSecret, fastHashedSecret, displaySecret, `Auto-generated for ${slug}`, projectId, now],
    );

    log.info("Created Langfuse API keys", { projectId, publicKey });

    return { projectId, publicKey, secretKey };
  } finally {
    await client.end();
  }
}

export async function deleteProject(projectId: string): Promise<void> {
  if (!isConfigured()) return;

  const client = new pg.Client({ connectionString: getConnectionUrl() });
  await client.connect();

  try {
    await client.query(`DELETE FROM api_keys WHERE project_id = $1`, [projectId]);
    await client.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    log.info("Deleted Langfuse project", { projectId });
  } catch (err) {
    log.error("Failed to delete Langfuse project", { projectId, error: String(err) });
  } finally {
    await client.end();
  }
}

export const langfuseAdmin = { isConfigured, createProject, deleteProject };
