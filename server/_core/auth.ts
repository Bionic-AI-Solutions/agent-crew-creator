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
import { SignJWT, jwtVerify } from "jose";
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

const issuerUrl = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`;
const authorizationUrl = `${issuerUrl}/protocol/openid-connect/auth`;
const tokenUrl = `${issuerUrl}/protocol/openid-connect/token`;
const logoutUrl = `${issuerUrl}/protocol/openid-connect/logout`;

const secret = new TextEncoder().encode(SESSION_SECRET);

// ── Session helpers ─────────────────────────────────────────────

export interface SessionUser {
  sub: string;
  email: string;
  name: string;
  role: "admin" | "user";
}

async function createSessionToken(user: SessionUser): Promise<string> {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(secret);
}

export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
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

      // Decode the access token to get user info
      const payload = JSON.parse(
        Buffer.from(tokens.access_token.split(".")[1], "base64url").toString(),
      );

      // Map Keycloak roles to app roles
      const realmRoles: string[] = payload.realm_access?.roles || [];
      const role: "admin" | "user" = realmRoles.includes("admin") ? "admin" : "user";

      const user: SessionUser = {
        sub: payload.sub,
        email: payload.email || "",
        name: payload.name || payload.preferred_username || "",
        role,
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

  // Logout
  router.post("/logout", (_req: Request, res: Response) => {
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
