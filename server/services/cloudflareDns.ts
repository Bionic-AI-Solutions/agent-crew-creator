/**
 * Cloudflare DNS for per-app player UI hostnames ({slug}.{suffix}).
 * Runs during player_ui provisioning so public DNS (and Let's Encrypt HTTP-01) can resolve the host.
 *
 * Credentials are loaded from Vault on every call so token rotation in KV is picked up immediately.
 *
 * Vault KV v2 path: secret/data/<CLOUDFLARE_VAULT_KV_PATH>
 * Default: `shared/cloudflare` (Vault API: GET /v1/secret/data/shared/cloudflare)
 *
 * Supported keys (string values; vault overrides env when both are set):
 * - api_token (or cloudflare_api_token) — also CLOUDFLARE_API_TOKEN
 * - zone_id — also CLOUDFLARE_ZONE_ID
 * - zone_ids — JSON object string mapping zone name → id, e.g. {"baisoln.com":"<uuid>"} (uses PLAYER_UI_HOST_SUFFIX to pick)
 * - zone_name — also CLOUDFLARE_ZONE_NAME (e.g. baisoln.com) if not using zone_id / zone_ids
 * - wan_ip | WAN_IP | dns_target_ip | player_ui_dns_target_ip — also PLAYER_UI_DNS_TARGET_IP (WAN / Kong public IPv4)
 * - dns_proxied | proxied — "true" for orange cloud; also CLOUDFLARE_DNS_PROXIED
 *
 * Env-only mode still works when Vault is empty/unconfigured (local dev).
 *
 * Production: player_ui requires this config unless PLAYER_UI_SKIP_CLOUDFLARE_DNS=true (dev only).
 */
import { promises as dns } from "node:dns";
import { createLogger } from "../_core/logger.js";
import { readPlatformVaultPath } from "../vaultClient.js";

const log = createLogger("CloudflareDns");

const CF_API = "https://api.cloudflare.com/client/v4";

/** Relative to secret/data/ — e.g. shared/cloudflare */
function cloudflareVaultKvPath(): string {
  return process.env.CLOUDFLARE_VAULT_KV_PATH?.trim() || "shared/cloudflare";
}

function playerUiHostSuffix(): string {
  return (process.env.PLAYER_UI_HOST_SUFFIX || "baisoln.com").replace(/^\.+/, "");
}

/** Public hostname for the agent player UI (same as Ingress host). */
export function getPlayerUiFqdn(slug: string): string {
  return `${slug}.${playerUiHostSuffix()}`;
}

/** First matching Vault key (case-insensitive). */
function pickFromVault(data: Record<string, string> | null, ...candidates: string[]): string | undefined {
  if (!data) return undefined;
  const byLowerKey = new Map<string, string>();
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t) continue;
    byLowerKey.set(k.toLowerCase(), t);
  }
  for (const c of candidates) {
    const hit = byLowerKey.get(c.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/** Parse zone_ids JSON like {"baisoln.com":"<zone_uuid>"}; prefers PLAYER_UI_HOST_SUFFIX. */
function zoneIdFromZoneIdsJson(data: Record<string, string> | null): string | undefined {
  const raw = pickFromVault(data, "zone_ids", "zone_ids_json");
  if (!raw) return undefined;
  try {
    const map = JSON.parse(raw) as Record<string, string>;
    if (!map || typeof map !== "object") return undefined;
    const suffix = playerUiHostSuffix();
    const byKey = map[suffix]?.trim();
    if (byKey) return byKey;
    const first = Object.values(map).find((v) => typeof v === "string" && v.trim());
    return first?.trim();
  } catch {
    return undefined;
  }
}

export interface CloudflareDnsConfig {
  apiToken: string;
  zoneId?: string;
  zoneName?: string;
  targetIp: string;
  proxied: boolean;
}

/**
 * Merge Vault KV data with process.env into a usable config (exported for unit tests).
 */
export function mergeCloudflareDnsConfig(vaultData: Record<string, string> | null): CloudflareDnsConfig | null {
  const apiToken =
    pickFromVault(vaultData, "api_token", "cloudflare_api_token") ||
    process.env.CLOUDFLARE_API_TOKEN?.trim();
  const zoneId =
    pickFromVault(vaultData, "zone_id") ||
    zoneIdFromZoneIdsJson(vaultData) ||
    process.env.CLOUDFLARE_ZONE_ID?.trim();
  const zoneName =
    pickFromVault(vaultData, "zone_name") ||
    process.env.CLOUDFLARE_ZONE_NAME?.trim();
  const targetIp =
    pickFromVault(vaultData, "wan_ip", "dns_target_ip", "player_ui_dns_target_ip") ||
    process.env.PLAYER_UI_DNS_TARGET_IP?.trim();
  const proxied =
    pickFromVault(vaultData, "dns_proxied", "proxied") === "true" ||
    process.env.CLOUDFLARE_DNS_PROXIED === "true";

  if (!apiToken || !targetIp || (!zoneId && !zoneName)) return null;
  return { apiToken, zoneId, zoneName, targetIp, proxied };
}

/**
 * Resolve Cloudflare + WAN target from Vault (preferred) with env fallback.
 * Reads Vault on each invocation so the latest api_token is always used.
 */
export async function resolveCloudflareDnsConfig(): Promise<CloudflareDnsConfig | null> {
  let vaultData: Record<string, string> | null = null;
  try {
    vaultData = await readPlatformVaultPath(cloudflareVaultKvPath());
  } catch (err) {
    log.warn("Vault read for Cloudflare config failed", { error: String(err) });
  }
  return mergeCloudflareDnsConfig(vaultData);
}

let _zoneCache: { key: string; zoneId: string } | null = null;

interface CfResponse<T> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: T;
}

async function cfFetch<T>(apiToken: string, path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith("http") ? path : `${CF_API}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = (await res.json()) as CfResponse<T>;
  if (!body.success) {
    const msg = body.errors?.map((e) => e.message).join("; ") || res.statusText;
    throw new Error(`Cloudflare API error: ${msg}`);
  }
  return body.result as T;
}

async function resolveZoneId(config: CloudflareDnsConfig): Promise<string> {
  if (config.zoneId) return config.zoneId;

  const name = config.zoneName;
  if (!name) throw new Error("Cloudflare zone_id or zone_name required");

  const cacheKey = `name:${name}`;
  if (_zoneCache?.key === cacheKey) return _zoneCache.zoneId;

  const zones = await cfFetch<Array<{ id: string; name: string }>>(
    config.apiToken,
    `/zones?name=${encodeURIComponent(name)}`,
  );
  const zone = zones[0];
  if (!zone?.id) {
    throw new Error(`Cloudflare zone not found for name "${name}"`);
  }
  _zoneCache = { key: cacheKey, zoneId: zone.id };
  log.info("Resolved Cloudflare zone", { zoneId: zone.id, zoneName: zone.name });
  return zone.id;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

/**
 * Create or update A record for the player UI hostname (WAN → hostname; Kong routes Host to app Ingress).
 */
export async function ensurePlayerUiARecord(slug: string): Promise<void> {
  const config = await resolveCloudflareDnsConfig();
  if (!config) {
    log.info(
      "Cloudflare player UI DNS skipped (Vault secret/data/" +
        cloudflareVaultKvPath() +
        " or env: api_token, zone_id|zone_name, wan_ip|PLAYER_UI_DNS_TARGET_IP)",
      { slug },
    );
    return;
  }

  const fqdn = getPlayerUiFqdn(slug);
  const zoneId = await resolveZoneId(config);
  const { targetIp, proxied, apiToken } = config;

  const list = await cfFetch<DnsRecord[]>(
    apiToken,
    `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(fqdn)}`,
  );
  const existing = list[0];

  const payload = {
    type: "A" as const,
    name: fqdn,
    content: targetIp,
    ttl: 120,
    proxied,
    comment: "bionic-platform player-ui",
  };

  if (existing?.id) {
    if (existing.content === targetIp && existing.type === "A") {
      log.info("Cloudflare A record already correct", { fqdn, targetIp });
      return;
    }
    await cfFetch<DnsRecord>(apiToken, `/zones/${zoneId}/dns_records/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    log.info("Updated Cloudflare A record for player UI", { fqdn, targetIp, proxied });
    return;
  }

  await cfFetch<DnsRecord>(apiToken, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  log.info("Created Cloudflare A record for player UI", { fqdn, targetIp, proxied });
}

/**
 * Remove A record for the player UI hostname (best-effort on app deletion).
 */
export async function deletePlayerUiARecord(slug: string): Promise<void> {
  const config = await resolveCloudflareDnsConfig();
  if (!config) return;

  const fqdn = getPlayerUiFqdn(slug);
  const zoneId = await resolveZoneId(config);
  const list = await cfFetch<DnsRecord[]>(
    config.apiToken,
    `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(fqdn)}`,
  );
  const existing = list[0];
  if (!existing?.id) {
    log.info("No Cloudflare A record to delete", { fqdn });
    return;
  }
  await cfFetch(config.apiToken, `/zones/${zoneId}/dns_records/${existing.id}`, { method: "DELETE" });
  log.info("Deleted Cloudflare A record for player UI", { fqdn });
}

function normalizeDnsName(n: string): string {
  return n.replace(/\.$/, "").toLowerCase();
}

/**
 * Confirm Cloudflare has an A record for the player UI FQDN whose content is the configured WAN IP.
 */
export async function verifyCloudflarePlayerUiARecord(slug: string): Promise<void> {
  const config = await resolveCloudflareDnsConfig();
  if (!config) {
    throw new Error("verifyCloudflarePlayerUiARecord: Cloudflare config not available");
  }
  const fqdn = getPlayerUiFqdn(slug);
  const wantName = normalizeDnsName(fqdn);
  const zoneId = await resolveZoneId(config);
  const list = await cfFetch<DnsRecord[]>(
    config.apiToken,
    `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(fqdn)}`,
  );
  const rec = list.find((r) => r.type === "A" && normalizeDnsName(r.name) === wantName);
  if (!rec) {
    throw new Error(`Cloudflare verification: no A record found for ${fqdn}`);
  }
  if (rec.content.trim() !== config.targetIp.trim()) {
    throw new Error(
      `Cloudflare verification: A record for ${fqdn} has content ${rec.content}, expected WAN ${config.targetIp}`,
    );
  }
  log.info("Verified Cloudflare A record matches WAN for player UI", { fqdn, targetIp: config.targetIp });
}

/**
 * Wait until a public DNS lookup returns the WAN address (DNS only; use after ensurePlayerUiARecord).
 * When Cloudflare proxy (orange cloud) is on, resolvers typically return Cloudflare anycast IPs — skip this check in that case.
 */
export async function waitPublicDnsResolvesToWan(
  fqdn: string,
  wanIp: string,
  timeoutMs = 120_000,
  intervalMs = 5_000,
): Promise<boolean> {
  const want = wanIp.trim();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const addresses = await dns.resolve4(fqdn);
      if (addresses.includes(want)) {
        log.info("Public DNS resolves player UI hostname to WAN", { fqdn, wanIp: want, addresses });
        return true;
      }
      log.info("Public DNS not yet pointing to WAN", { fqdn, want, addresses });
    } catch (err) {
      log.info("Public DNS lookup failed (propagation or NXDOMAIN)", { fqdn, err: String(err) });
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
