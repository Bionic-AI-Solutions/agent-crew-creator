/**
 * Document cleanup — synchronous attempt on delete with a periodic
 * retry sweep for anything that failed.
 *
 * Life cycle of a soft-deleted row in `agent_documents`:
 *
 *   1. deleteDocument mutation marks processing_status = 'deleted',
 *      sets deleted_at = now().
 *   2. cleanupDocument() runs best-effort:
 *        - DELETE each Letta archival passage (idempotent)
 *        - removeObject on MinIO (idempotent — missing is OK)
 *        - if both succeed, hard-delete the DB row.
 *        - on failure, flip status to 'delete_failed'; deleted_at stays.
 *   3. startCleanupCron() runs every CLEANUP_INTERVAL_MS, retries any
 *      row whose status is 'deleted' or 'delete_failed' and whose
 *      deleted_at is older than CLEANUP_RETRY_DELAY_MS (so we don't
 *      double-attempt while step 2 is still in flight).
 *
 * Failure modes we tolerate:
 *   - MinIO object already gone (removeObject returns without throwing
 *     on 404 at the SDK level, and we swallow any throw anyway).
 *   - Letta passage already gone (404 is treated as success).
 *   - Letta agent itself deleted — passages are gone with it; we
 *     detect that and treat as success.
 *
 * Non-goals: this is not a general-purpose GC. Rows without a
 * deleted_at timestamp are never touched by the sweep.
 */
import { and, eq, inArray, lt, or } from "drizzle-orm";
import { createLogger } from "../_core/logger.js";
import { agentDocuments, apps, agentConfigs } from "../../drizzle/platformSchema.js";
import type { Database } from "../db.js";

const log = createLogger("DocumentCleanup");

const CLEANUP_INTERVAL_MS = 5 * 60_000;      // sweep every 5 min
const CLEANUP_RETRY_DELAY_MS = 60_000;       // wait ≥ 1 min after soft-delete
const CLEANUP_BATCH_SIZE = 50;

const LETTA_BASE = (process.env.LETTA_INTERNAL_URL || process.env.LETTA_BASE_URL || "").replace(/\/+$/, "");
const LETTA_TOKEN = process.env.LETTA_API_KEY || process.env.MCP_API_KEY || "";
const LETTA_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  ...(LETTA_TOKEN ? { Authorization: `Bearer ${LETTA_TOKEN}` } : {}),
};

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "minio-tenant-hl.minio.svc.cluster.local:9000";
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === "true";
const MINIO_ROOT_USER = process.env.MINIO_ROOT_USER || "";
const MINIO_ROOT_PASSWORD = process.env.MINIO_ROOT_PASSWORD || "";

let _minioClient: any = null;
async function getMinioClient() {
  if (_minioClient) return _minioClient;
  if (!MINIO_ROOT_USER || !MINIO_ROOT_PASSWORD) {
    throw new Error("MinIO creds not configured — MINIO_ROOT_USER/PASSWORD missing");
  }
  const Minio = await import("minio");
  const [host, portStr] = MINIO_ENDPOINT.split(":");
  _minioClient = new Minio.Client({
    endPoint: host,
    port: parseInt(portStr || "9000", 10),
    useSSL: MINIO_USE_SSL,
    accessKey: MINIO_ROOT_USER,
    secretKey: MINIO_ROOT_PASSWORD,
  });
  return _minioClient;
}

async function deleteLettaPassage(agentId: string, passageId: string): Promise<void> {
  if (!LETTA_BASE || !agentId) return;
  const url = `${LETTA_BASE}/v1/agents/${agentId}/archival/${passageId}/`;
  const res = await fetch(url, { method: "DELETE", headers: LETTA_HEADERS });
  // 404 = already gone; treat as success. Any other non-2xx throws.
  if (!res.ok && res.status !== 404) {
    throw new Error(`Letta passage delete ${passageId} failed: ${res.status} ${await res.text()}`);
  }
}

async function deleteMinioObject(bucket: string, key: string): Promise<void> {
  if (!bucket || !key) return;
  try {
    const client = await getMinioClient();
    await client.removeObject(bucket, key);
  } catch (err: any) {
    // NoSuchKey / NoSuchBucket -> already gone, swallow. Anything else
    // bubbles so the caller can mark delete_failed.
    const code = err?.code || "";
    if (code === "NoSuchKey" || code === "NoSuchBucket" || code === "NotFound") return;
    throw err;
  }
}

/**
 * Attempt cleanup for a single document. Hard-deletes the row on
 * success; marks it delete_failed on any error so the cron can retry.
 */
export async function cleanupDocument(
  db: Database,
  docId: number,
): Promise<{ status: "cleaned" | "failed"; error?: string }> {
  const [doc] = await db
    .select()
    .from(agentDocuments)
    .where(eq(agentDocuments.id, docId))
    .limit(1);
  if (!doc) return { status: "cleaned" }; // already gone

  // Resolve the bucket name via agent -> app.slug. The agent may have
  // been deleted ahead of this doc — if so, the row is an orphan, so
  // we still hard-delete it after best-effort MinIO attempt.
  let bucket = "";
  let lettaAgentId = "";
  const joined = await db
    .select({ slug: apps.slug, lettaAgentId: agentConfigs.lettaAgentId })
    .from(agentConfigs)
    .innerJoin(apps, eq(apps.id, agentConfigs.appId))
    .where(eq(agentConfigs.id, doc.agentConfigId))
    .limit(1);
  if (joined[0]) {
    bucket = joined[0].slug;
    lettaAgentId = joined[0].lettaAgentId || "";
  }

  const passageIds: string[] = Array.isArray(doc.lettaPassageIds) ? doc.lettaPassageIds : [];

  try {
    // Letta first — if the agent was already deleted upstream these
    // calls 404 and we move on.
    if (lettaAgentId && passageIds.length > 0) {
      for (const pid of passageIds) {
        await deleteLettaPassage(lettaAgentId, pid);
      }
    }
    if (bucket && doc.minioKey) {
      await deleteMinioObject(bucket, doc.minioKey);
    }
    await db.delete(agentDocuments).where(eq(agentDocuments.id, doc.id));
    log.info("Document hard-deleted", { id: doc.id, filename: doc.filename });
    return { status: "cleaned" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("Document cleanup failed (will retry via cron)", {
      id: doc.id,
      filename: doc.filename,
      error: msg,
    });
    await db
      .update(agentDocuments)
      .set({ processingStatus: "delete_failed", error: msg.slice(0, 500) })
      .where(eq(agentDocuments.id, doc.id));
    return { status: "failed", error: msg };
  }
}

/**
 * Sweep for soft-deleted docs needing cleanup. Picks up both the
 * initial 'deleted' state (retries missed by the synchronous path)
 * and 'delete_failed' rows (prior retry failures).
 */
export async function runCleanupSweep(db: Database): Promise<{ processed: number; cleaned: number; failed: number }> {
  const cutoff = new Date(Date.now() - CLEANUP_RETRY_DELAY_MS);
  const candidates = await db
    .select({ id: agentDocuments.id })
    .from(agentDocuments)
    .where(
      and(
        or(
          eq(agentDocuments.processingStatus, "deleted"),
          eq(agentDocuments.processingStatus, "delete_failed"),
        )!,
        lt(agentDocuments.deletedAt, cutoff),
      ),
    )
    .limit(CLEANUP_BATCH_SIZE);

  let cleaned = 0;
  let failed = 0;
  for (const { id } of candidates) {
    const result = await cleanupDocument(db, id);
    if (result.status === "cleaned") cleaned++;
    else failed++;
  }
  if (candidates.length > 0) {
    log.info("Document cleanup sweep", { processed: candidates.length, cleaned, failed });
  }
  return { processed: candidates.length, cleaned, failed };
}

let _cronHandle: NodeJS.Timeout | null = null;

/**
 * Start the periodic cleanup sweep. Idempotent — calling twice is a
 * no-op. Fires immediately at startup to catch rows left behind by a
 * prior crash, then every CLEANUP_INTERVAL_MS.
 */
export function startCleanupCron(db: Database): void {
  if (_cronHandle) return;
  log.info("Starting document cleanup cron", { intervalMs: CLEANUP_INTERVAL_MS });
  // Fire once shortly after boot to sweep up anything left behind.
  setTimeout(() => {
    void runCleanupSweep(db).catch((err) => log.warn("Initial sweep failed", { error: String(err) }));
  }, 30_000);
  _cronHandle = setInterval(() => {
    void runCleanupSweep(db).catch((err) => log.warn("Periodic sweep failed", { error: String(err) }));
  }, CLEANUP_INTERVAL_MS);
  // Don't keep the event loop alive on shutdown.
  if (_cronHandle && typeof _cronHandle.unref === "function") _cronHandle.unref();
}

export function stopCleanupCron(): void {
  if (_cronHandle) {
    clearInterval(_cronHandle);
    _cronHandle = null;
  }
}
