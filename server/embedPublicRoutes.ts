/**
 * Public embed routes — served WITHOUT authentication.
 *
 * These Express routes let external websites connect to deployed agents
 * using embed tokens. They are registered BEFORE express.static and the
 * SPA catch-all in index.ts to prevent the catch-all from swallowing them.
 *
 * CORS: per-route `origin: true, credentials: false` — compatible with
 * browser fetch from any origin. Does NOT touch the global CORS config.
 */
import type { Express, Request, Response } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { eq } from "drizzle-orm";
import { AccessToken } from "livekit-server-sdk";
import { RoomAgentDispatch, RoomConfiguration } from "@livekit/protocol";
import { randomUUID } from "crypto";
import { createLogger } from "./_core/logger.js";
import { getDb } from "./db.js";
import { embedTokens, agentConfigs, apps } from "../drizzle/platformSchema.js";
import { readAppSecret } from "./vaultClient.js";

const log = createLogger("EmbedPublic");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EMBED_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes

// ── Rate limiter (Redis-backed with in-memory fallback) ──────────
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_MAX_ENTRIES = 100_000;

// In-memory fallback
const rateLimitMap = new Map<string, number[]>();

// Redis client (lazy-init)
let _redisClient: any = null;
let _redisAvailable = false;

async function getRedisClient() {
  if (_redisClient) return _redisAvailable ? _redisClient : null;
  const redisUrl = process.env.REDIS_URL || process.env.REDIS_RATE_LIMIT_URL;
  if (!redisUrl) return null;
  try {
    const Redis = (await import("ioredis")).default;
    _redisClient = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
    await _redisClient.connect();
    _redisAvailable = true;
    _redisClient.on("error", () => { _redisAvailable = false; });
    _redisClient.on("connect", () => { _redisAvailable = true; });
    return _redisClient;
  } catch {
    _redisAvailable = false;
    return null;
  }
}

async function isRateLimitedRedis(key: string): Promise<boolean> {
  const redis = await getRedisClient();
  if (!redis) return isRateLimitedMemory(key); // fallback

  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const redisKey = `rl:${key}`;
  try {
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(redisKey, 0, windowStart);
    pipeline.zadd(redisKey, now, `${now}-${Math.random()}`);
    pipeline.zcard(redisKey);
    pipeline.expire(redisKey, Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) + 1);
    const results = await pipeline.exec();
    const count = results?.[2]?.[1] as number || 0;
    return count > RATE_LIMIT_MAX;
  } catch {
    return isRateLimitedMemory(key); // fallback on error
  }
}

function isRateLimitedMemory(token: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(token) ?? [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitMap.set(token, recent);
    return true;
  }
  recent.push(now);
  rateLimitMap.set(token, recent);
  return false;
}

function isRateLimited(token: string): boolean {
  // Synchronous check for backward compat — async Redis version used where possible
  return isRateLimitedMemory(token);
}

// Clean up stale in-memory entries
setInterval(() => {
  const now = Date.now();
  for (const [token, timestamps] of rateLimitMap) {
    const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length === 0) rateLimitMap.delete(token);
    else rateLimitMap.set(token, recent);
  }
  if (rateLimitMap.size > RATE_LIMIT_MAX_ENTRIES) {
    const keys = rateLimitMap.keys();
    for (let i = 0; i < rateLimitMap.size - RATE_LIMIT_MAX_ENTRIES; i++) {
      const { value } = keys.next();
      if (value) rateLimitMap.delete(value);
    }
  }
}, 5 * 60_000);

// ── Vault helpers (same as playgroundRouter) ────────────────────
interface VaultLiveKit {
  livekit_api_key: string;
  livekit_api_secret: string;
  livekit_url: string;
}

function pickLiveKit(vault: Record<string, string> | null, slug: string): VaultLiveKit | null {
  if (!vault) return null;
  const apiKey = vault.livekit_api_key;
  const apiSecret = vault.livekit_api_secret;
  const url = vault.livekit_url;
  if (!apiKey || !apiSecret || !url) return null;
  return { livekit_api_key: apiKey, livekit_api_secret: apiSecret, livekit_url: url };
}

function shortRand(): string {
  return randomUUID().slice(0, 8);
}

// ── CORS config for embed routes ────────────────────────────────
const embedCors = cors({ origin: true, credentials: false });

export function registerEmbedRoutes(app: Express): void {
  // Preflight for all embed API routes
  app.options("/api/embed/*", embedCors);

  // ── POST /api/embed/connection-details ──────────────────────
  app.post("/api/embed/connection-details", embedCors, async (req: Request, res: Response) => {
    try {
      const { embedToken, visitorId } = req.body ?? {};
      if (!embedToken || typeof embedToken !== "string") {
        res.status(400).json({ error: "embedToken is required" });
        return;
      }

      // Rate limit (async — uses Redis when available, memory fallback)
      if (await isRateLimitedRedis(embedToken)) {
        res.status(429).json({ error: "Rate limit exceeded. Try again later." });
        return;
      }

      const db = await getDb();
      if (!db) {
        res.status(503).json({ error: "Database unavailable" });
        return;
      }

      // Look up token
      const [tokenRow] = await db
        .select()
        .from(embedTokens)
        .where(eq(embedTokens.token, embedToken))
        .limit(1);
      if (!tokenRow || !tokenRow.isActive) {
        res.status(403).json({ error: "Invalid or revoked embed token" });
        return;
      }

      // Origin check
      const origin = req.headers.origin;
      if (tokenRow.allowedOrigins && tokenRow.allowedOrigins.length > 0 && origin) {
        if (!tokenRow.allowedOrigins.includes(origin)) {
          res.status(403).json({ error: "Origin not allowed for this embed token" });
          return;
        }
      }

      // Look up agent + app
      const [agent] = await db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, tokenRow.agentConfigId))
        .limit(1);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      if (!agent.deployed) {
        res.status(412).json({ error: "Agent is not deployed" });
        return;
      }

      const [appRow] = await db
        .select()
        .from(apps)
        .where(eq(apps.id, tokenRow.appId))
        .limit(1);
      if (!appRow) {
        res.status(404).json({ error: "App not found" });
        return;
      }

      // Vault read
      const vault = await readAppSecret(appRow.slug);
      const lk = pickLiveKit(vault, appRow.slug);
      if (!lk) {
        res.status(503).json({ error: "LiveKit credentials not configured" });
        return;
      }

      // Identity: stable visitor ID or ephemeral
      const identity =
        visitorId && typeof visitorId === "string"
          ? `embed-vis-${visitorId.slice(0, 36)}`
          : `embed-${shortRand()}`;

      const roomName = `embed-${appRow.slug}-${agent.id}-${shortRand()}`;
      const dispatchName = `${appRow.slug}-${agent.name}`;

      const at = new AccessToken(lk.livekit_api_key, lk.livekit_api_secret, {
        identity,
        name: "Visitor",
        ttl: EMBED_TOKEN_TTL_SECONDS,
      });
      at.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        roomCreate: true,
      });
      at.roomConfig = new RoomConfiguration({
        agents: [new RoomAgentDispatch({ agentName: dispatchName })],
      });

      const participantToken = await at.toJwt();

      // Update lastUsedAt (fire-and-forget)
      db.update(embedTokens)
        .set({ lastUsedAt: new Date() } as any)
        .where(eq(embedTokens.id, tokenRow.id))
        .then(() => {})
        .catch(() => {});

      log.info("Embed connection minted", {
        tokenId: tokenRow.id,
        agentId: agent.id,
        slug: appRow.slug,
        roomName,
        identity,
      });

      res.json({
        serverUrl: lk.livekit_url,
        roomName,
        participantToken,
        participantName: "Visitor",
        config: {
          allowVoice: tokenRow.allowVoice,
          allowChat: tokenRow.allowChat,
          allowVideo: tokenRow.allowVideo,
          allowScreenShare: tokenRow.allowScreenShare,
          allowAvatar: tokenRow.allowAvatar,
          showTranscription: tokenRow.showTranscription,
          theme: tokenRow.theme,
          agentHasAvatar: agent.avatarEnabled,
        },
      });
    } catch (err) {
      log.error("Embed connection-details error", { error: String(err) });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── GET /api/s3-proxy/:bucket/* ──────────────────────────────
  // Proxies presigned MinIO URLs through the platform server so browsers
  // don't need to reach the private MinIO IP directly (avoids Chrome's
  // Private Network Access block on s3.baisoln.com → 192.168.0.x).
  const MAX_S3_PROXY_SIZE = 10 * 1024 * 1024; // 10MB cap

  app.get("/api/s3-proxy/:bucket/*", embedCors, async (req: Request, res: Response) => {
    try {
      const bucket = req.params.bucket;
      const objectKey = req.params[0]; // everything after /bucket/
      if (!bucket || !objectKey) {
        res.status(400).send("Missing bucket or key");
        return;
      }

      // Reject path traversal and injection in bucket/key
      if (bucket.includes("..") || bucket.includes("/") || bucket.includes("%2f") || !bucket) {
        res.status(400).send("Invalid bucket name");
        return;
      }

      // Validate bucket is a known app slug (tenant isolation) — REQUIRED, not optional
      const db = await getDb();
      if (!db) {
        res.status(503).send("Service unavailable");
        return;
      }
      const [appRow] = await db.select({ id: apps.id }).from(apps).where(eq(apps.slug, bucket)).limit(1);
      if (!appRow) {
        res.status(403).send("Unknown bucket");
        return;
      }
      if (objectKey.includes("..")) {
        res.status(400).send("Invalid object key");
        return;
      }

      // Only allow known object key prefixes (defense in depth)
      const allowedPrefixes = ["avatars/", "audio/", "images/", "documents/", "crew-outputs/"];
      if (!allowedPrefixes.some((p) => objectKey.startsWith(p))) {
        res.status(403).send("Object key prefix not allowed");
        return;
      }

      // Cap query string length to prevent abuse
      const qs = req.url.split("?")[1] || "";
      if (qs.length > 2000) {
        res.status(400).send("Query string too long");
        return;
      }

      const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "minio-tenant-hl.minio.svc.cluster.local:9000";
      const internalUrl = `http://${MINIO_ENDPOINT}/${bucket}/${objectKey}`;
      const fetchUrl = qs ? `${internalUrl}?${qs}` : internalUrl;

      const upstream = await fetch(fetchUrl, {
        headers: { Host: MINIO_ENDPOINT },
      });

      if (!upstream.ok) {
        res.status(upstream.status).send(`Upstream: ${upstream.statusText}`);
        return;
      }

      const contentType = upstream.headers.get("content-type") || "application/octet-stream";
      if (!contentType.startsWith("image/")) {
        res.status(403).send("Only image content allowed via proxy");
        return;
      }

      // Enforce size cap before streaming
      const contentLength = parseInt(upstream.headers.get("content-length") || "0", 10);
      if (contentLength > MAX_S3_PROXY_SIZE) {
        res.status(413).send("Image too large");
        return;
      }

      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=3600");
      if (contentLength) res.setHeader("Content-Length", String(contentLength));

      // Stream response instead of buffering entire body
      if (upstream.body) {
        const { Readable } = await import("stream");
        const readable = Readable.fromWeb(upstream.body as any);
        let streamed = 0;
        readable.on("data", (chunk: Buffer) => {
          streamed += chunk.length;
          if (streamed > MAX_S3_PROXY_SIZE) {
            readable.destroy();
            if (!res.headersSent) res.status(413).send("Image too large");
            return;
          }
          res.write(chunk);
        });
        readable.on("end", () => res.end());
        readable.on("error", () => {
          if (!res.headersSent) res.status(502).send("Proxy stream error");
        });
      } else {
        const body = await upstream.arrayBuffer();
        if (body.byteLength > MAX_S3_PROXY_SIZE) {
          res.status(413).send("Image too large");
          return;
        }
        res.send(Buffer.from(body));
      }
    } catch (err) {
      log.error("S3 proxy error", { error: String(err) });
      res.status(502).send("Proxy error");
    }
  });

  // ── GET /api/embed/widget.js ────────────────────────────────
  app.get("/api/embed/widget.js", embedCors, (_req: Request, res: Response) => {
    const widgetPath = path.resolve(__dirname, "..", "dist", "public", "embed-popup.js");
    res.setHeader("Content-Type", "application/javascript");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(widgetPath, (err) => {
      if (err) {
        log.warn("Widget file not found", { path: widgetPath });
        res.status(404).send("// embed widget not built yet");
      }
    });
  });

  // ── GET /embed/:embedToken ──────────────────────────────────
  app.get("/embed/:embedToken", async (req: Request, res: Response) => {
    try {
      const { embedToken } = req.params;

      const db = await getDb();
      if (!db) {
        res.status(503).send("Database unavailable");
        return;
      }

      const [tokenRow] = await db
        .select()
        .from(embedTokens)
        .where(eq(embedTokens.token, embedToken as string))
        .limit(1);
      if (!tokenRow || !tokenRow.isActive) {
        res.status(403).send("Invalid or revoked embed token");
        return;
      }

      // Derive the platform origin for widget.js URL
      const proto = req.headers["x-forwarded-proto"] || req.protocol;
      const host = req.headers["x-forwarded-host"] || req.headers.host;
      const platformOrigin = `${proto}://${host}`;

      // Build CSP frame-ancestors from token's allowedOrigins (validated origins only)
      const originRegex = /^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/;
      const validOrigins = (tokenRow.allowedOrigins || []).filter((o: string) => originRegex.test(o));
      const frameAncestors = validOrigins.length > 0
        ? `'self' https://platform.baisoln.com https://platform.bionicaisolutions.com ${validOrigins.join(" ")}`
        : "'self' https://platform.baisoln.com https://platform.bionicaisolutions.com";
      res.setHeader("Content-Security-Policy", `frame-ancestors ${frameAncestors}`);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent Embed</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/x-icon" href="/favicon.ico" sizes="32x32" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body, #embed-root { width: 100%; height: 100%; overflow: hidden; }
  </style>
</head>
<body>
  <div id="embed-root"></div>
  <script>
    window.__BIONIC_EMBED_CONFIG__ = {
      embedToken: ${JSON.stringify(embedToken)},
      platformOrigin: ${JSON.stringify(platformOrigin)},
      mode: "iframe"
    };
  </script>
  <script src="${platformOrigin}/api/embed/widget.js" defer></script>
</body>
</html>`);
    } catch (err) {
      log.error("Embed iframe route error", { error: String(err) });
      res.status(500).send("Internal server error");
    }
  });

  log.info("Embed public routes registered");
}
