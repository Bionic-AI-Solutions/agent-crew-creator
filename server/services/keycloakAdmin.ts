/**
 * Keycloak Admin REST API client for managing per-app OIDC clients.
 */
import { createLogger } from "../_core/logger.js";

const log = createLogger("KeycloakAdmin");

// Use internal URL for admin API calls (server-to-server, no Kong hop)
// KEYCLOAK_URL is the public URL for browser redirects
// KEYCLOAK_INTERNAL_URL is for admin REST API calls from within the cluster
const KEYCLOAK_URL = process.env.KEYCLOAK_INTERNAL_URL || process.env.KEYCLOAK_URL || "http://keycloak.keycloak.svc.cluster.local:80";
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || "Bionic";
const ADMIN_USER = process.env.KEYCLOAK_ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD || "";

let _accessToken: string | null = null;
let _tokenExpiry = 0;

async function getAdminToken(): Promise<string> {
  if (_accessToken && Date.now() < _tokenExpiry) return _accessToken;

  const res = await fetch(
    `${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: ADMIN_USER,
        password: ADMIN_PASSWORD,
      }),
    },
  );

  if (!res.ok) throw new Error(`Keycloak admin auth failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  _accessToken = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in - 30) * 1000;
  return _accessToken;
}

async function adminRequest(method: string, path: string, body?: unknown): Promise<any> {
  const token = await getAdminToken();
  const url = `${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    // 409 = already exists — not an error for create operations
    if (res.status === 409) {
      log.info("Resource already exists (409)", { path });
      return { alreadyExists: true };
    }
    throw new Error(`Keycloak ${method} ${path} failed (${res.status}): ${text}`);
  }

  if (res.status === 201) {
    const location = res.headers.get("location");
    return { location };
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) return res.json();
  return null;
}

function defaultRedirectUris(slug: string): string[] {
  const uris = [
    `https://${slug}.bionicaisolutions.com/*`,
    `https://${slug}.baisoln.com/*`,
  ];
  // Only allow localhost redirects in development
  if (process.env.NODE_ENV !== "production") {
    uris.push("http://localhost:*/*");
  }
  return uris;
}

function defaultWebOrigins(slug: string): string[] {
  if (process.env.NODE_ENV === "production") {
    // Explicit origins in production — no wildcard "+"
    return [
      `https://${slug}.bionicaisolutions.com`,
      `https://${slug}.baisoln.com`,
      "https://platform.baisoln.com",
      "https://platform.bionicaisolutions.com",
    ];
  }
  return ["+"]; // Allow all origins in development
}

export async function createPublicClient(slug: string) {
  const clientId = `${slug}-public`;
  const result = await adminRequest("POST", "/clients", {
    clientId,
    name: `${slug} Public Client`,
    publicClient: true,
    directAccessGrantsEnabled: true,
    standardFlowEnabled: true,
    redirectUris: defaultRedirectUris(slug),
    webOrigins: defaultWebOrigins(slug),
  });

  if (result?.alreadyExists) {
    // Fetch existing client
    const clients = await adminRequest("GET", `/clients?clientId=${clientId}`);
    const existing = clients?.[0];
    log.info("Public client already exists", { clientId });
    return { clientId, keycloakId: existing?.id || "" };
  }

  const keycloakId = result?.location?.split("/").pop() || "";
  log.info("Created public client", { clientId });
  return { clientId, keycloakId };
}

export async function createConfidentialClient(slug: string) {
  const clientId = `${slug}-confidential`;
  const result = await adminRequest("POST", "/clients", {
    clientId,
    name: `${slug} Confidential Client`,
    publicClient: false,
    serviceAccountsEnabled: true,
    directAccessGrantsEnabled: false,
    redirectUris: defaultRedirectUris(slug),
    webOrigins: defaultWebOrigins(slug),
  });

  let keycloakId = "";
  if (result?.alreadyExists) {
    const clients = await adminRequest("GET", `/clients?clientId=${clientId}`);
    keycloakId = clients?.[0]?.id || "";
    log.info("Confidential client already exists", { clientId });
  } else {
    keycloakId = result?.location?.split("/").pop() || "";
    log.info("Created confidential client", { clientId });
  }

  // Get client secret
  let clientSecret = "";
  if (keycloakId) {
    const secretResult = await adminRequest("GET", `/clients/${keycloakId}/client-secret`);
    clientSecret = secretResult?.value || "";
  }

  return { clientId, clientSecret, keycloakId };
}

export async function createRoles(slug: string): Promise<void> {
  const roles = [`${slug}-admin`, `${slug}-user`];
  for (const role of roles) {
    try {
      await adminRequest("POST", "/roles", { name: role, description: `Role for ${slug}` });
    } catch (err: any) {
      if (String(err).includes("409")) continue; // Already exists
      throw err;
    }
  }
  log.info("Created roles", { slug });
}

export async function deleteClients(slug: string): Promise<void> {
  // Keycloak search is exact match — delete each known client by name
  for (const suffix of ["-public", "-confidential"]) {
    const clientId = `${slug}${suffix}`;
    try {
      const clients = await adminRequest("GET", `/clients?clientId=${clientId}`);
      for (const client of clients || []) {
        if (client.clientId === clientId) {
          await adminRequest("DELETE", `/clients/${client.id}`);
          log.info("Deleted client", { clientId: client.clientId });
        }
      }
    } catch (err: any) {
      log.warn("Failed to delete client", { clientId, error: String(err) });
    }
  }
}

export async function deleteRoles(slug: string): Promise<void> {
  const roleNames = [`${slug}-admin`, `${slug}-user`];
  for (const roleName of roleNames) {
    try {
      await adminRequest("DELETE", `/roles/${roleName}`);
      log.info("Deleted role", { roleName });
    } catch (err: any) {
      if (String(err).includes("404")) continue; // Already deleted
      log.warn("Failed to delete role", { roleName, error: String(err) });
    }
  }
}

/**
 * Create a single realm-level role (idempotent). Used for platform-wide
 * roles like "Admin" and "Analyst" that gate the crew templates UI.
 */
export async function createRealmRole(name: string, description?: string): Promise<void> {
  try {
    await adminRequest("POST", "/roles", { name, description: description || `${name} role` });
    log.info("Created realm role", { name });
  } catch (err: any) {
    if (String(err).includes("409")) {
      log.info("Realm role already exists", { name });
      return;
    }
    throw err;
  }
}

/** List realm-level roles. */
export async function listRealmRoles(): Promise<Array<{ id: string; name: string }>> {
  const roles = await adminRequest("GET", "/roles");
  return Array.isArray(roles) ? roles : [];
}

export async function exportClientConfig(slug: string): Promise<unknown> {
  try {
    const clients = await adminRequest("GET", `/clients?clientId=${slug}-`);
    return clients;
  } catch {
    return null;
  }
}

export const keycloakAdmin = {
  createPublicClient,
  createConfidentialClient,
  createRoles,
  createRealmRole,
  listRealmRoles,
  deleteClients,
  deleteRoles,
  exportClientConfig,
  defaultRedirectUris,
};
