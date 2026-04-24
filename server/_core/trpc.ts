import { initTRPC, TRPCError } from "@trpc/server";
import type { Request, Response } from "express";
import superjson from "superjson";
import { getUserFromRequest, type SessionUser } from "./auth.js";
import { getDb, type Database } from "../db.js";

// ── Context ─────────────────────────────────────────────────────

export interface Context {
  req: Request;
  res: Response;
  user: SessionUser | null;
  db: Database | null;
}

export async function createContext({ req, res }: { req: Request; res: Response }): Promise<Context> {
  const user = await getUserFromRequest(req);
  const db = await getDb();
  return { req, res, user, db: db as Database | null };
}

// ── tRPC init ───────────────────────────────────────────────────

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const middleware = t.middleware;

// ── Procedures ──────────────────────────────────────────────────

/** Public — no auth required */
export const publicProcedure = t.procedure;

/** Protected — requires authenticated user */
const isAuthenticated = middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const protectedProcedure = t.procedure.use(isAuthenticated);

/**
 * App-scoped routes currently share the platform's authenticated app list
 * visibility model. Keep this helper explicit so routers that mint scoped
 * credentials have a single place to tighten membership checks later.
 */
export async function assertAppMembership(ctx: Context, _appId: number): Promise<void> {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
}

export const appScopedProcedure = protectedProcedure;

/** Admin — requires admin role */
const isAdmin = middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const adminProcedure = t.procedure.use(isAdmin);

/** Analyst or Admin — used by the crew templates feature. Either the
 *  legacy "admin" coarse role OR the realm role "Analyst" / "Admin"
 *  (case-insensitive) grants access. Falls through to FORBIDDEN otherwise. */
const isAnalystOrAdmin = middleware(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  const roles = (ctx.user.realmRoles || []).map((r) => r.toLowerCase());
  const allowed =
    ctx.user.role === "admin" || roles.includes("admin") || roles.includes("analyst");
  if (!allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Analyst or Admin role required",
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const analystOrAdminProcedure = t.procedure.use(isAnalystOrAdmin);
