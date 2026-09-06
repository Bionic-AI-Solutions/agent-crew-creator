/**
 * Vault KV v2 HTTP client for storing per-app secrets.
 * Path convention: secret/data/t6-apps/<app-slug>/config
 */
import { readFile } from "node:fs/promises";
import { createLogger } from "./_core/logger.js";

const log = createLogger("Vault");

const VAULT_ADDR = process.env.VAULT_ADDR || "";

/**
 * Kubernetes auth (preferred). Vault mints a short-lived token against the
 * pod's ServiceAccount JWT, and we renew it before it lapses. Nothing static
 * to expire, so the credential cannot silently rot the way an operator-pasted
 * token does.
 */
const VAULT_K8S_ROLE = process.env.VAULT_K8S_ROLE || "";
const VAULT_K8S_MOUNT = process.env.VAULT_K8S_MOUNT || "kubernetes";
const VAULT_K8S_JWT_PATH =
  process.env.VAULT_K8S_JWT_PATH ||
  "/var/run/secrets/kubernetes.io/serviceaccount/token";

/**
 * Token read from a file (e.g. a projected Secret). Re-read periodically, so
 * rotating the Secret takes effect without restarting the pod.
 */
const VAULT_TOKEN_FILE = process.env.VAULT_TOKEN_FILE || "";
const TOKEN_FILE_TTL_MS = 60_000;

/**
 * Legacy static token. An env var is fixed for the life of the process, so a
 * rotation here still needs a pod restart — prefer the two modes above.
 */
const VAULT_TOKEN = process.env.VAULT_TOKEN || "";

/** Never let a token get within this much of its expiry before refreshing. */
const MIN_SKEW_MS = 60_000;

type AuthMode = "kubernetes" | "file" | "static" | "none";

function authMode(): AuthMode {
  if (VAULT_K8S_ROLE) return "kubernetes";
  if (VAULT_TOKEN_FILE) return "file";
  if (VAULT_TOKEN) return "static";
  return "none";
}

/** Whether the current mode can mint a replacement after a rejection. */
function canRefresh(): boolean {
  const mode = authMode();
  return mode === "kubernetes" || mode === "file";
}

interface CachedToken {
  token: string;
  /** Epoch ms past which we refuse to reuse this token (skew already applied). */
  expiresAt: number;
  renewable: boolean;
}

let cached: CachedToken | null = null;
let inflight: Promise<CachedToken> | null = null;

/** Refresh once we are inside the larger of 60s or 10% of the lease. */
function expiryFromLease(leaseSeconds: number): number {
  if (!leaseSeconds || leaseSeconds <= 0) return Number.POSITIVE_INFINITY;
  const skew = Math.max(MIN_SKEW_MS, leaseSeconds * 100);
  return Date.now() + Math.max(0, leaseSeconds * 1000 - skew);
}

function isFresh(t: CachedToken | null): t is CachedToken {
  return Boolean(t && Date.now() < t.expiresAt);
}

interface VaultAuthResponse {
  auth?: {
    client_token?: string;
    lease_duration?: number;
    renewable?: boolean;
  };
}

async function kubernetesLogin(): Promise<CachedToken> {
  const jwt = (await readFile(VAULT_K8S_JWT_PATH, "utf8")).trim();
  if (!jwt) {
    throw new Error(`Vault Kubernetes auth: JWT at ${VAULT_K8S_JWT_PATH} is empty`);
  }
  const res = await fetch(`${VAULT_ADDR}/v1/auth/${VAULT_K8S_MOUNT}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: VAULT_K8S_ROLE, jwt }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Vault Kubernetes login failed (${res.status}) for role '${VAULT_K8S_ROLE}': ${text}`,
    );
  }
  const body = (await res.json()) as VaultAuthResponse;
  const token = body.auth?.client_token;
  if (!token) {
    throw new Error("Vault Kubernetes login returned no client_token");
  }
  const lease = body.auth?.lease_duration ?? 0;
  log.info("Vault Kubernetes auth succeeded", {
    role: VAULT_K8S_ROLE,
    leaseSeconds: lease || "unlimited",
  });
  return {
    token,
    expiresAt: expiryFromLease(lease),
    renewable: Boolean(body.auth?.renewable),
  };
}

/** Extend the current lease. Returns null if Vault declines, so we re-login. */
async function renewSelf(current: CachedToken): Promise<CachedToken | null> {
  try {
    const res = await fetch(`${VAULT_ADDR}/v1/auth/token/renew-self`, {
      method: "POST",
      headers: {
        "X-Vault-Token": current.token,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as VaultAuthResponse;
    const lease = body.auth?.lease_duration ?? 0;
    if (!lease) return null;
    log.debug("Renewed Vault token lease", { leaseSeconds: lease });
    return {
      token: current.token,
      expiresAt: expiryFromLease(lease),
      renewable: Boolean(body.auth?.renewable),
    };
  } catch {
    return null;
  }
}

async function fileToken(): Promise<CachedToken> {
  const token = (await readFile(VAULT_TOKEN_FILE, "utf8")).trim();
  if (!token) {
    throw new Error(`Vault token file ${VAULT_TOKEN_FILE} is empty`);
  }
  return {
    token,
    expiresAt: Date.now() + TOKEN_FILE_TTL_MS,
    renewable: false,
  };
}

/**
 * A still-configured static credential, used only to ride out a failed
 * Kubernetes login. Cached briefly (not forever) so we keep retrying the
 * proper auth path rather than silently settling on the legacy token.
 */
async function staticFallback(): Promise<CachedToken | null> {
  if (VAULT_TOKEN_FILE) {
    try {
      return await fileToken();
    } catch {
      return null;
    }
  }
  if (VAULT_TOKEN) {
    return {
      token: VAULT_TOKEN,
      expiresAt: Date.now() + TOKEN_FILE_TTL_MS,
      renewable: false,
    };
  }
  return null;
}

async function acquireToken(): Promise<CachedToken> {
  const mode = authMode();

  if (mode === "kubernetes") {
    if (cached?.renewable) {
      const renewed = await renewSelf(cached);
      if (renewed) {
        cached = renewed;
        return renewed;
      }
    }
    try {
      const fresh = await kubernetesLogin();
      cached = fresh;
      return fresh;
    } catch (err) {
      // Enabling Kubernetes auth before the Vault role exists must not take
      // Vault reads down. Ride out the misconfiguration on whatever static
      // credential is still configured, loudly, and retry the login shortly.
      const fallback = await staticFallback();
      if (!fallback) throw err;
      log.error(
        "Vault Kubernetes login FAILED — falling back to the static token. " +
          "Fix the Vault role; this fallback can itself expire.",
        { role: VAULT_K8S_ROLE, mount: VAULT_K8S_MOUNT, error: String(err) },
      );
      cached = fallback;
      return fallback;
    }
  }

  if (mode === "file") {
    const next = await fileToken();
    cached = next;
    return next;
  }

  if (mode === "static") {
    const next: CachedToken = {
      token: VAULT_TOKEN,
      expiresAt: Number.POSITIVE_INFINITY,
      renewable: false,
    };
    cached = next;
    return next;
  }

  throw new Error(
    "Vault auth not configured — set VAULT_K8S_ROLE, VAULT_TOKEN_FILE or VAULT_TOKEN.",
  );
}

/** Single-flight token acquisition so a burst of reads triggers one login. */
function getToken(): Promise<CachedToken> {
  if (isFresh(cached)) return Promise.resolve(cached);
  if (!inflight) {
    inflight = acquireToken().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

function isConfigured(): boolean {
  return Boolean(VAULT_ADDR) && authMode() !== "none";
}

/** Drop the cached token so the next call re-authenticates. */
export function invalidateVaultToken(): void {
  cached = null;
}

async function vaultRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  if (!isConfigured()) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `Vault not configured in production — cannot ${method} ${path}. ` +
          `Set VAULT_ADDR plus one of VAULT_K8S_ROLE, VAULT_TOKEN_FILE or VAULT_TOKEN.`,
      );
    }
    log.warn("Vault not configured — skipping (dev only)", { path });
    return null;
  }
  return sendWithAuth(method, path, body, true);
}

async function sendWithAuth(
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  allowRetry: boolean,
): Promise<unknown> {
  const { token } = await getToken();
  const url = `${VAULT_ADDR}/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-Vault-Token": token,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // 401/403 means Vault rejected the credential and did NOT perform the
  // operation, so retrying after re-auth is safe even for writes. This is the
  // case that used to surface as "app not provisioned" once the token lapsed.
  if ((res.status === 401 || res.status === 403) && allowRetry && canRefresh()) {
    await res.text().catch(() => "");
    log.warn("Vault rejected token — re-authenticating and retrying once", {
      path,
      status: res.status,
      mode: authMode(),
    });
    invalidateVaultToken();
    return sendWithAuth(method, path, body, false);
  }

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(
      `Vault ${method} ${path} failed (${res.status}): ${text}`,
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
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

/**
 * Handle a failed Vault read.
 *
 * A read *miss* and a read *failure* are different things. Vault answers 404
 * for a path that genuinely holds no data, and callers reasonably treat that
 * as "absent". Anything else — a 403 from an expired token, a connection
 * error — means we do not know what is there, and collapsing it to null makes
 * a broken credential look identical to an unprovisioned app.
 *
 * That is not hypothetical: when the platform's Vault token expired, every
 * read 403'd, readAppSecret returned null, and the Playground reported
 * "LiveKit not provisioned" — sending debugging at LiveKit for hours when the
 * fault was an expired token. Callers still receive null so behaviour is
 * unchanged, but a real failure is now loud instead of silent.
 */
function handleReadFailure(path: string, err: unknown): null {
  const status = (err as { status?: number } | undefined)?.status;
  if (status === 404) {
    log.debug("Vault path holds no data", { path });
  } else {
    log.error(
      "Vault read FAILED — returning null, but this does NOT mean the secret is absent",
      { path, status: status ?? "none", error: String(err) },
    );
  }
  return null;
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
  } catch (err) {
    return handleReadFailure(path, err);
  }
}

/**
 * Like readAppSecret, but keeps "absent" and "could not read" distinct.
 *
 * Returns null only for a genuine 404. Any other failure — an expired token,
 * a denied policy, an unreachable Vault — throws, so a caller can say "the
 * platform cannot read its secrets" rather than "this app was never
 * provisioned". Those two produce very different operator responses: the
 * second invites a re-provision that would mint new LiveKit keys for no
 * reason.
 */
export async function readAppSecretStrict(
  slug: string,
): Promise<Record<string, string> | null> {
  const path = `secret/data/t6-apps/${slug}/config`;
  try {
    const result = (await vaultRequest("GET", path)) as {
      data?: { data?: Record<string, string> };
    } | null;
    return result?.data?.data || null;
  } catch (err) {
    const status = (err as { status?: number } | undefined)?.status;
    if (status === 404) return null;
    throw err;
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
  } catch (err) {
    return handleReadFailure(path, err);
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
      data?: { data?: Record<string, string>; metadata?: { version?: number } };
    } | null;
    return result?.data?.data || null;
  } catch (err) {
    return handleReadFailure(`secret/data/${path}`, err);
  }
}

/** Read with version metadata for CAS writes. */
export async function readPlatformVaultPathWithVersion(
  path: string,
): Promise<{ data: Record<string, string>; version: number } | null> {
  try {
    const result = (await vaultRequest("GET", `secret/data/${path}`)) as {
      data?: { data?: Record<string, string>; metadata?: { version?: number } };
    } | null;
    const data = result?.data?.data;
    const version = result?.data?.metadata?.version ?? 0;
    if (!data) return null;
    return { data, version };
  } catch (err) {
    return handleReadFailure(`secret/data/${path}`, err);
  }
}

export async function writePlatformVaultPath(
  path: string,
  data: Record<string, string>,
  cas?: number,
): Promise<void> {
  const body: Record<string, unknown> = { data };
  if (cas !== undefined) {
    body.options = { cas };
  }
  await vaultRequest("POST", `secret/data/${path}`, body);
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
  readAppSecretStrict,
  readPlatformSecret,
  writePlatformSecret,
  createEsoPolicy,
  deleteEsoPolicy,
  isConfigured,
};
