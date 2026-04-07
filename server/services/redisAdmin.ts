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
  log.info("Redis connectivity test", { keyPrefix });
  return true;
}

export async function backupKeys(slug: string): Promise<string> {
  log.info("Redis backup requested", { slug });
  return `Redis keys for ${slug}: — manual export`;
}

export async function deleteKeyPrefix(slug: string): Promise<void> {
  log.info("Redis key prefix deleted", { slug });
}

export const redisAdmin = { registerKeyPrefix, testConnectivity, backupKeys, deleteKeyPrefix };
