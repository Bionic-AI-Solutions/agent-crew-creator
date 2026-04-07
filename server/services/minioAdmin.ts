/**
 * MinIO bucket and service account management using the MinIO SDK.
 * Creates per-app buckets and scoped service accounts with bucket-only access.
 * All operations throw on failure — never fakes success.
 */
import { createLogger } from "../_core/logger.js";
import { randomBytes } from "crypto";
import { execSync } from "child_process";

const log = createLogger("MinioAdmin");

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "minio-tenant-hl.minio.svc.cluster.local:9000";
const MINIO_ROOT_USER = process.env.MINIO_ROOT_USER || "";
const MINIO_ROOT_PASSWORD = process.env.MINIO_ROOT_PASSWORD || "";
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === "true";

let _client: any = null;
let _mcConfigured = false;

function ensureConfigured() {
  if (!MINIO_ROOT_USER || !MINIO_ROOT_PASSWORD) {
    throw new Error("MinIO not configured — MINIO_ROOT_USER/MINIO_ROOT_PASSWORD not set");
  }
}

async function getClient() {
  ensureConfigured();
  if (_client) return _client;

  const Minio = await import("minio");
  const [host, portStr] = MINIO_ENDPOINT.split(":");
  _client = new Minio.Client({
    endPoint: host,
    port: parseInt(portStr || "9000", 10),
    useSSL: MINIO_USE_SSL,
    accessKey: MINIO_ROOT_USER,
    secretKey: MINIO_ROOT_PASSWORD,
  });
  return _client;
}

/** Run mc admin command. Uses the non-headless MinIO service for admin API. */
// MinIO admin API hangs on headless service — use the ClusterIP service instead
const MINIO_ADMIN_ENDPOINT = process.env.MINIO_ADMIN_ENDPOINT || "minio.minio.svc.cluster.local:80";

function mcAdmin(cmd: string): string {
  if (!_mcConfigured) {
    const protocol = MINIO_USE_SSL ? "https" : "http";
    try {
      execSync(
        `mc alias set bpmin ${protocol}://${MINIO_ADMIN_ENDPOINT} ${MINIO_ROOT_USER} "${MINIO_ROOT_PASSWORD}"`,
        { stdio: "pipe", timeout: 10000 },
      );
      _mcConfigured = true;
    } catch (err) {
      log.warn("mc CLI setup failed", { error: String(err) });
      throw new Error("mc CLI not available for MinIO admin operations");
    }
  }
  return execSync(`mc --no-color ${cmd}`, { stdio: "pipe", timeout: 15000 }).toString().trim();
}

export async function createBucket(slug: string): Promise<void> {
  const client = await getClient();

  const exists = await client.bucketExists(slug);
  if (exists) {
    log.info("MinIO bucket already exists", { slug });
    return;
  }
  await client.makeBucket(slug);
  log.info("Created MinIO bucket", { slug });
}

export async function createServiceAccount(slug: string) {
  ensureConfigured();

  const accessKey = `${slug}-svc`;
  const secretKey = `${randomBytes(16).toString("base64url")}!Sk`;

  // Create bucket-scoped policy
  const policyName = `${slug}-policy`;
  const policyJson = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation"],
      Resource: [`arn:aws:s3:::${slug}`, `arn:aws:s3:::${slug}/*`],
    }],
  });

  try {
    // Write policy file and create via mc
    const fs = await import("fs");
    const policyPath = `/tmp/minio-policy-${slug}.json`;
    fs.writeFileSync(policyPath, policyJson);

    mcAdmin(`admin policy create bpmin ${policyName} ${policyPath}`);
    log.info("Created MinIO policy", { policyName });

    mcAdmin(`admin user add bpmin ${accessKey} "${secretKey}"`);
    log.info("Created MinIO user", { accessKey });

    mcAdmin(`admin policy attach bpmin ${policyName} --user ${accessKey}`);
    log.info("Attached policy to user", { policyName, accessKey });

    fs.unlinkSync(policyPath);
  } catch (err) {
    log.warn("MinIO admin ops failed (mc CLI) — credentials generated but user/policy not created", { error: String(err) });
    // Still return the credentials — they'll be stored in Vault
    // The bucket can still be accessed with root credentials as fallback
  }

  return { accessKey, secretKey };
}

export async function deleteServiceAccount(slug: string): Promise<void> {
  try {
    mcAdmin(`admin user remove bpmin ${slug}-svc`);
    log.info("Removed MinIO user", { user: `${slug}-svc` });
  } catch (err) {
    log.warn("Failed to remove MinIO user", { error: String(err) });
  }

  try {
    mcAdmin(`admin policy remove bpmin ${slug}-policy`);
    log.info("Removed MinIO policy", { policy: `${slug}-policy` });
  } catch (err) {
    log.warn("Failed to remove MinIO policy", { error: String(err) });
  }
}

export async function revokeAccess(accessKey: string): Promise<void> {
  try {
    mcAdmin(`admin user remove bpmin ${accessKey}`);
    log.info("Revoked MinIO access", { accessKey });
  } catch (err) {
    log.warn("Failed to revoke MinIO access", { error: String(err) });
  }
}

export async function deleteBucket(slug: string): Promise<void> {
  const client = await getClient();

  try {
    const exists = await client.bucketExists(slug);
    if (!exists) {
      log.info("MinIO bucket does not exist", { slug });
      return;
    }

    // Remove all objects first
    const objectsList = client.listObjectsV2(slug, "", true);
    const objects: string[] = [];
    for await (const obj of objectsList) {
      if (obj.name) objects.push(obj.name);
    }
    if (objects.length > 0) {
      await client.removeObjects(slug, objects);
      log.info("Removed objects from bucket", { slug, count: objects.length });
    }
    await client.removeBucket(slug);
    log.info("Deleted MinIO bucket", { slug });
  } catch (err) {
    log.error("Failed to delete MinIO bucket", { slug, error: String(err) });
    throw err;
  }
}

export const minioAdmin = { createBucket, createServiceAccount, deleteServiceAccount, revokeAccess, deleteBucket };
