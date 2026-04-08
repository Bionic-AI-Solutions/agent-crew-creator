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

/**
 * Generic Vault KV v2 read at an arbitrary path under `secret/data/`.
 * Used for shared/cross-app paths like `t6-apps/livekit/config` that
 * don't fit the per-app `t6-apps/<slug>/config` convention.
 */
export async function readPlatformVaultPath(
  path: string,
): Promise<Record<string, string> | null> {
  try {
    const result = (await vaultRequest("GET", `secret/data/${path}`)) as {
      data?: { data?: Record<string, string> };
    } | null;
    return result?.data?.data || null;
  } catch {
    return null;
  }
}

export async function writePlatformVaultPath(
  path: string,
  data: Record<string, string>,
): Promise<void> {
  await vaultRequest("POST", `secret/data/${path}`, { data });
  log.info("Wrote platform Vault path", { path });
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

export const vault = {
  writeAppSecret,
  deleteAppSecret,
  readAppSecret,
  readPlatformSecret,
  writePlatformSecret,
  createEsoPolicy,
  deleteEsoPolicy,
  isConfigured,
};
