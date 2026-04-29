/**
 * Vault KV v2 HTTP client for storing per-app secrets.
 * Path convention: secret/data/t6-apps/<app-slug>/config
 */
import { createLogger } from "./_core/logger.js";

const log = createLogger("Vault");

const VAULT_ADDR = process.env.VAULT_ADDR || "";
const VAULT_TOKEN = process.env.VAULT_TOKEN || "";

function isConfigured(): boolean {
  return Boolean(VAULT_ADDR && VAULT_TOKEN);
}

async function vaultRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  if (!isConfigured()) {
    log.warn("Vault not configured — skipping", { path });
    return null;
  }

  const url = `${VAULT_ADDR}/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-Vault-Token": VAULT_TOKEN,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vault ${method} ${path} failed (${res.status}): ${text}`);
  }

  if (res.status === 204) return null;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  }
  return null;
}

export async function writeAppSecret(
  slug: string,
  data: Record<string, string>,
): Promise<void> {
  const path = `secret/data/t6-apps/${slug}/config`;
  try {
    await vaultRequest("POST", path, { data });
    log.info("Wrote secret to Vault", { path });
  } catch (error) {
    log.error("Failed to write secret to Vault", { path, error: String(error) });
    throw error;
  }
}

export async function deleteAppSecret(slug: string): Promise<void> {
  const path = `secret/metadata/t6-apps/${slug}/config`;
  try {
    await vaultRequest("DELETE", path);
    log.info("Deleted secret from Vault", { path });
  } catch (error) {
    log.error("Failed to delete secret from Vault", { path, error: String(error) });
  }
}

export async function readAppSecret(
  slug: string,
): Promise<Record<string, string> | null> {
  const path = `secret/data/t6-apps/${slug}/config`;
  try {
    const result = (await vaultRequest("GET", path)) as {
      data?: { data?: Record<string, string> };
    } | null;
    return result?.data?.data || null;
  } catch {
    return null;
  }
}

/**
 * Read a platform-wide secret (not tied to any tenant app).
 * Path convention: secret/data/platform/<name>
 * Used for shared service credentials like search MCP API keys, SMTP creds, etc.
 */
export async function readPlatformSecret(
  name: string,
): Promise<Record<string, string> | null> {
  const path = `secret/data/platform/${name}`;
  try {
    const result = (await vaultRequest("GET", path)) as {
      data?: { data?: Record<string, string> };
    } | null;
    return result?.data?.data || null;
  } catch {
    return null;
  }
}

export async function writePlatformSecret(
  name: string,
  data: Record<string, string>,
): Promise<void> {
  const path = `secret/data/platform/${name}`;
  await vaultRequest("POST", path, { data });
  log.info("Wrote platform secret to Vault", { path });
}

export async function createEsoPolicy(slug: string): Promise<void> {
  const policyName = `eso-${slug}`;
  const hcl = `path "secret/data/t6-apps/${slug}/*" {\n  capabilities = ["read"]\n}\npath "secret/data/shared/*" {\n  capabilities = ["read"]\n}`;
  const path = `sys/policies/acl/${policyName}`;
  try {
    await vaultRequest("PUT", path, { policy: hcl });
    log.info("Created Vault ESO policy", { policyName });
  } catch (error) {
    log.error("Failed to create ESO policy", { policyName, error: String(error) });
    throw error;
  }
}

export async function deleteEsoPolicy(slug: string): Promise<void> {
  const policyName = `eso-${slug}`;
  const path = `sys/policies/acl/${policyName}`;
  try {
    await vaultRequest("DELETE", path);
    log.info("Deleted Vault ESO policy", { policyName });
  } catch (error) {
    log.error("Failed to delete ESO policy", { error: String(error) });
  }
}

/**
 * Read the data from an arbitrary Vault KV-v2 path (e.g. "t6-apps/livekit/config").
 * Use for shared multi-tenant config paths that don't follow the per-app convention.
 */
export async function readGenericSecret(
  vaultPath: string,
): Promise<Record<string, string>> {
  const path = `secret/data/${vaultPath}`;
  try {
    const result = (await vaultRequest("GET", path)) as {
      data?: { data?: Record<string, string> };
    } | null;
    return result?.data?.data || {};
  } catch (error) {
    log.warn("Failed to read generic Vault secret", { path, error: String(error) });
    return {};
  }
}

/**
 * Merge new properties into an arbitrary Vault KV-v2 path WITHOUT clobbering
 * existing properties. Used by multi-tenant shared config paths (e.g. the
 * LiveKit key map at t6-apps/livekit/config) where each tenant adds two keys
 * but the existing tenants' keys must remain intact.
 */
export async function mergeGenericSecret(
  vaultPath: string,
  data: Record<string, string>,
): Promise<void> {
  const path = `secret/data/${vaultPath}`;
  const existing = await readGenericSecret(vaultPath);
  const merged = { ...existing, ...data };
  try {
    await vaultRequest("POST", path, { data: merged });
    log.info("Merged keys into Vault path", { path, addedKeys: Object.keys(data) });
  } catch (error) {
    log.error("Failed to merge into Vault path", { path, error: String(error) });
    throw error;
  }
}

/**
 * Remove specific fields from an arbitrary Vault KV-v2 path while preserving
 * all other fields. Mirrors mergeGenericSecret for the cleanup path.
 */
export async function deleteGenericSecretFields(
  vaultPath: string,
  fields: string[],
): Promise<void> {
  const path = `secret/data/${vaultPath}`;
  const existing = await readGenericSecret(vaultPath);
  const next: Record<string, string> = { ...existing };
  for (const f of fields) delete next[f];
  try {
    await vaultRequest("POST", path, { data: next });
    log.info("Removed fields from Vault path", { path, fields });
  } catch (error) {
    log.error("Failed to remove fields from Vault path", { path, error: String(error) });
  }
}

export const vault = {
  writeAppSecret,
  deleteAppSecret,
  readAppSecret,
  readPlatformSecret,
  writePlatformSecret,
  createEsoPolicy,
  deleteEsoPolicy,
  readGenericSecret,
  mergeGenericSecret,
  deleteGenericSecretFields,
  isConfigured,
};
