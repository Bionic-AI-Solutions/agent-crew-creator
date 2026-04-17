/**
 * Shared Redis client for rate limiting, session revocation, and ephemeral stores.
 * Falls back gracefully when Redis is not configured (single-replica deployments).
 */
import { createLogger } from "./_core/logger.js";

const log = createLogger("Redis");

let _client: any = null;
let _available = false;
let _initialized = false;

export async function getRedisClient(): Promise<any | null> {
  if (_initialized) return _available ? _client : null;
  _initialized = true;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    log.info("REDIS_URL not set — using in-memory fallbacks");
    return null;
  }

  try {
    const Redis = (await import("ioredis")).default;
    _client = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 5000 });
    await _client.connect();
    _available = true;
    _client.on("error", () => { _available = false; });
    _client.on("connect", () => { _available = true; });
    log.info("Redis connected", { url: redisUrl.replace(/\/\/.*@/, "//***@") });
    return _client;
  } catch (err) {
    log.warn("Redis connection failed — using in-memory fallbacks", { error: String(err) });
    _available = false;
    return null;
  }
}

export function isRedisAvailable(): boolean {
  return _available;
}
