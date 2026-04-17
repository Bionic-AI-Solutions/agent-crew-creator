/**
 * Keycloak OIDC authentication.
 *
 * Handles:
 * - /api/auth/login  → redirect to Keycloak
 * - /api/auth/callback → exchange code for tokens, set session cookie
 * - /api/auth/logout → clear session
 * - /api/auth/me → return current user from cookie
 */
import { Router, type Request, type Response } from "express";
import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";
import { createLogger } from "./logger.js";

const log = createLogger("Auth");

// ── Config ──────────────────────────────────────────────────────

const KEYCLOAK_URL = process.env.KEYCLOAK_URL || "https://auth.bionicaisolutions.com";
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM || "Bionic";
const CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || "bionic-platform";
const CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.KEYCLOAK_REDIRECT_URI || "http://localhost:5173/api/auth/callback";
const SESSION_SECRET = process.env.SESSION_SECRET || (() => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set in production — refusing to start with insecure default");
  }
  return "dev-secret-change-me";
})();
const COOKIE_NAME = "bp_session";

// Warn loudly if NODE_ENV is not explicitly "production" in a non-local environment
if (process.env.NODE_ENV !== "production" && process.env.KUBERNETES_SERVICE_HOST) {
  log.warn("⚠️  NODE_ENV is not 'production' but running in K8s — dev-only auth fallbacks are ACTIVE. "
    + "This means JWKS bypass, KC wildcard origins, and player-ui API without token are enabled. "
    + "Set NODE_ENV=production to enforce all security controls.");
}

const issuerUrl = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`;
const authorizationUrl = `${issuerUrl}/protocol/openid-connect/auth`;
const tokenUrl = `${issuerUrl}/protocol/openid-connect/token`;
const logoutUrl = `${issuerUrl}/protocol/openid-connect/logout`;

const secret = new TextEncoder().encode(SESSION_SECRET);

// ── Keycloak JWKS for access token verification ─────────────────
const jwksUrl = new URL(`${issuerUrl}/protocol/openid-connect/certs`);
const JWKS = createRemoteJWKSet(jwksUrl);

// ── Session helpers ─────────────────────────────────────────────

export interface SessionUser {
  sub: string;
  email: string;
  name: string;
  /** Coarse app role — kept for backward compat. Derived from platformRole. */
  role: "admin" | "user";
  /** Unified platform role derived from KC realm roles at login. */
  platformRole: import("../../shared/types.js").PlatformRole;
  /** Full set of Keycloak realm roles. */
  realmRoles: string[];
}

// ── Session token revocation (Redis-backed with in-memory fallback) ──
// Use a Map with insertion order for FIFO eviction (not bulk wipe)
const _revokedTokens = new Map<string, number>(); // jti → expiry timestamp
const REVOCATION_MAX_ENTRIES = 50_000;

async function revokeSessionToken(jti: string): Promise<void> {
  const expiry = Date.now() + 8 * 3600_000;
  _revokedTokens.set(jti, expiry);

  // FIFO eviction if over limit (Map preserves insertion order)
  if (_revokedTokens.size > REVOCATION_MAX_ENTRIES) {
    const firstKey = _revokedTokens.keys().next().value;
    if (firstKey) _revokedTokens.delete(firstKey);
  }

  try {
    const { getRedisClient } = await import("../redisClient.js");
    const redis = await getRedisClient();
    if (redis) {
      await redis.set(`revoked:${jti}`, "1", "EX", 8 * 3600);
    }
  } catch (err) {
    log.warn("Redis revocation write failed — in-memory only", { error: String(err) });
  }
}

async function isTokenRevoked(jti: string): Promise<boolean> {
  // Check in-memory first (fast path)
  const localExpiry = _revokedTokens.get(jti);
  if (localExpiry !== undefined) {
    if (localExpiry > Date.now()) return true;
    _revokedTokens.delete(jti); // Expired, clean up
  }

  // Check Redis (cross-replica)
  try {
    const { getRedisClient } = await import("../redisClient.js");
    const redis = await getRedisClient();
    if (redis) {
      const val = await redis.get(`revoked:${jti}`);
      return val !== null;
    }
  } catch {}
  return false;
}

// Clean expired entries from in-memory map periodically
setInterval(() => {
  const now = Date.now();
  for (const [jti, expiry] of _revokedTokens) {
    if (expiry <= now) _revokedTokens.delete(jti);
  }
}, 30 * 60_000);

async function createSessionToken(user: SessionUser): Promise<string> {
  const { randomUUID } = await import("crypto");
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(secret);
}

export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    // Check revocation list
    if (payload.jti && await isTokenRevoked(payload.jti as string)) return null;
    return payload as unknown as SessionUser;
  } catch {
    return null;
  }
}

export function getUserFromRequest(req: Request): Promise<SessionUser | null> {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return Promise.resolve(null);
  return verifySessionToken(token);
}

// ── Express Router ──────────────────────────────────────────────

export function createAuthRouter(): Router {
  const router = Router();

  // Redirect to Keycloak login
  router.get("/login", (_req: Request, res: Response) => {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "openid email profile",
    });
    res.redirect(`${authorizationUrl}?${params.toString()}`);
  });

  // Handle callback from Keycloak
  router.get("/callback", async (req: Request, res: Response) => {
    const code = req.query.code as string;
    if (!code) {
      res.status(400).send("Missing authorization code");
      return;
    }

    try {
      // Exchange code for tokens
      const tokenRes = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code,
          redirect_uri: REDIRECT_URI,
        }),
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        log.error("Token exchange failed", { status: tokenRes.status, body: text });
        res.status(500).send("Authentication failed");
        return;
      }

      const tokens = (await tokenRes.json()) as { access_token: string; id_token: string };

      // Verify and decode the access token against Keycloak's JWKS
      let payload: any;
      try {
        const { payload: verified } = await jwtVerify(tokens.access_token, JWKS, {
          issuer: issuerUrl,
          // Note: KC access tokens typically have aud:"account", not the client ID.
          // The azp (authorized party) claim contains the client ID instead.
        });
        // Validate azp matches our client (Keycloak's equivalent of audience for access tokens)
        if (verified.azp && verified.azp !== CLIENT_ID) {
          throw new Error(`Token azp "${verified.azp}" does not match expected client "${CLIENT_ID}"`);
        }
        payload = verified;
      } catch (verifyErr) {
        if (process.env.NODE_ENV === "production") {
          log.error("KC access token JWKS verification failed in production — rejecting login", {
            error: String(verifyErr),
          });
          res.status(500).send("Token verification failed — contact administrator");
          return;
        }
        // Dev only: fallback to decode without verification
        log.warn("KC access token JWKS verification failed (dev) — falling back to decode-only", {
          error: String(verifyErr),
        });
        payload = JSON.parse(
          Buffer.from(tokens.access_token.split(".")[1], "base64url").toString(),
        );
      }

      // Map Keycloak roles to unified platform role
      const realmRoles: string[] = payload.realm_access?.roles || [];
      const { derivePlatformRole } = await import("../../shared/types.js");
      const platformRole = derivePlatformRole(realmRoles);
      const role: "admin" | "user" = platformRole === "admin" || platformRole === "super_admin" ? "admin" : "user";

      const user: SessionUser = {
        sub: payload.sub,
        email: payload.email || "",
        name: payload.name || payload.preferred_username || "",
        role,
        platformRole,
        realmRoles,
      };

      const sessionToken = await createSessionToken(user);

      res.cookie(COOKIE_NAME, sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 8 * 60 * 60 * 1000, // 8 hours
        path: "/",
      });

      log.info("User authenticated", { email: user.email, role: user.role });
      res.redirect("/");
    } catch (err) {
      log.error("Auth callback error", { error: String(err) });
      res.status(500).send("Authentication failed");
    }
  });

  // Logout — revoke token + clear cookie
  router.post("/logout", async (req: Request, res: Response) => {
    // Revoke the current session token
    const token = req.cookies?.[COOKIE_NAME];
    if (token) {
      try {
        const { payload } = await jwtVerify(token, secret);
        if (payload.jti) revokeSessionToken(payload.jti as string);
      } catch { /* token already expired or invalid — fine */ }
    }
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.json({ success: true, logoutUrl });
  });

  // Current user
  router.get("/me", async (req: Request, res: Response) => {
    const user = await getUserFromRequest(req);
    if (!user) {
      res.status(401).json({ user: null });
      return;
    }
    res.json({ user });
  });

  return router;
}
