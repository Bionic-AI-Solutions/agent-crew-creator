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

/** App-scoped — requires authenticated user AND membership in the app
 *  identified by `input.appId`. Admins bypass the membership check.
 *  Use for any procedure that reads/writes data scoped to a single app. */
const isAppMember = middleware(async ({ ctx, next, getRawInput }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  // Admins bypass membership entirely.
  if (ctx.user.role === "admin") {
    return next({ ctx: { ...ctx, user: ctx.user } });
  }
  const input = (await getRawInput()) as { appId?: unknown } | undefined;
  const appId = typeof input?.appId === "number" ? input.appId : Number(input?.appId);
  if (!Number.isFinite(appId)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "appScopedProcedure requires numeric input.appId",
    });
  }
  if (!ctx.db) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
  }
  // Lazy import to avoid pulling schema into trpc core's import graph at boot.
  const { appMembers } = await import("../../drizzle/platformSchema.js");
  const { and, eq } = await import("drizzle-orm");
  const rows = await ctx.db
    .select({ id: appMembers.id })
    .from(appMembers)
    .where(and(eq(appMembers.appId, appId), eq(appMembers.userId, ctx.user.sub)))
    .limit(1);
  if (rows.length === 0) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Not a member of this app" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const appScopedProcedure = t.procedure.use(isAppMember);

/** Imperative membership check for procedures whose input does not directly
 *  carry `appId` (e.g. they take a resource id and must look up its `appId`
 *  first). Call this AFTER resolving the appId from the resource. Admins
 *  bypass; otherwise the user must have an `app_members` row for the app,
 *  optionally with `owner` role. */
export async function assertAppMembership(
  ctx: Context,
  appId: number,
  opts?: { requireOwner?: boolean },
): Promise<void> {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  if (ctx.user.role === "admin") return;
  if (!ctx.db) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
  }
  const { appMembers } = await import("../../drizzle/platformSchema.js");
  const { and, eq } = await import("drizzle-orm");
  const rows = await ctx.db
    .select({ role: appMembers.role })
    .from(appMembers)
    .where(and(eq(appMembers.appId, appId), eq(appMembers.userId, ctx.user.sub)))
    .limit(1);
  if (rows.length === 0) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Not a member of this app" });
  }
  if (opts?.requireOwner && rows[0].role !== "owner") {
    throw new TRPCError({ code: "FORBIDDEN", message: "App owner role required" });
  }
}
