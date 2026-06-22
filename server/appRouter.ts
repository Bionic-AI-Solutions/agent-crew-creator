import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { router, adminProcedure, protectedProcedure, appScopedProcedure, assertAppMembership } from "./_core/trpc.js";
import { createLogger } from "./_core/logger.js";
import { apps, appMembers, provisioningJobs } from "../drizzle/platformSchema.js";
import type { ServiceKey } from "../shared/provisioningTypes.js";

const log = createLogger("AppRouter");

export const appRouter = router({
  // ── List all apps ─────────────────────────────────────────────
  list: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.db) return [];
    let rows;
    if (ctx.user!.role === "admin") {
      rows = await ctx.db.select().from(apps).orderBy(apps.createdAt);
    } else {
      const memberships = await ctx.db
        .select({ appId: appMembers.appId })
        .from(appMembers)
        .where(eq(appMembers.userId, ctx.user!.sub));
      const appIds = memberships.map((m) => m.appId);
      if (appIds.length === 0) return [];
      rows = await ctx.db
        .select()
        .from(apps)
        .where(inArray(apps.id, appIds))
        .orderBy(apps.createdAt);
    }
    return rows.map((a) => ({
      ...a,
      apiKeyPrefix: a.apiKey ? a.apiKey.slice(0, 8) + "..." : "",
      apiKey: undefined,
      apiSecret: undefined,
    }));
  }),

  // ── Get single app ────────────────────────────────────────────
  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return null;
      const rows = await ctx.db.select().from(apps).where(eq(apps.id, input.id)).limit(1);
      const app = rows[0];
      if (!app) return null;
      if (ctx.user!.role !== "admin") {
        const m = await ctx.db
          .select({ id: appMembers.id })
          .from(appMembers)
          .where(and(eq(appMembers.appId, app.id), eq(appMembers.userId, ctx.user!.sub)))
          .limit(1);
        if (m.length === 0) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Not a member of this app" });
        }
      }
      return {
        ...app,
        apiKeyPrefix: app.apiKey ? app.apiKey.slice(0, 8) + "..." : "",
        apiKey: undefined,
        apiSecret: undefined,
      };
    }),

  // ── Get by slug ───────────────────────────────────────────────
  getBySlug: protectedProcedure
    .input(z.object({ slug: z.string() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return null;
      const rows = await ctx.db.select().from(apps).where(eq(apps.slug, input.slug)).limit(1);
      const app = rows[0];
      if (!app) return null;
      if (ctx.user!.role !== "admin") {
        const m = await ctx.db
          .select({ id: appMembers.id })
          .from(appMembers)
          .where(and(eq(appMembers.appId, app.id), eq(appMembers.userId, ctx.user!.sub)))
          .limit(1);
        if (m.length === 0) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Not a member of this app" });
        }
      }
      return {
        ...app,
        apiKeyPrefix: app.apiKey ? app.apiKey.slice(0, 8) + "..." : "",
        apiKey: undefined,
        apiSecret: undefined,
      };
    }),

  // ── Create app ────────────────────────────────────────────────
  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
        description: z.string().optional(),
        livekitUrl: z.string().url(),
        roomPrefix: z.string().optional(),
        enabledServices: z.array(z.enum([
          "livekit", "keycloak", "langfuse", "kubernetes", "postgres",
          "redis", "minio", "letta", "dify", "player_ui",
        ])).default(["livekit"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");

      // Insert app + member + provisioning job in a transaction
      const { SERVICE_LABELS } = await import("../shared/provisioningTypes.js");
      const PROVISION_ORDER: ServiceKey[] = [
        "livekit", "keycloak", "langfuse", "kubernetes",
        "postgres", "redis", "minio", "letta",
        "vault_policy", "player_ui", "verification",
      ];
      const steps = PROVISION_ORDER.map((name) => ({
        name,
        label: SERVICE_LABELS[name],
        status: "pending" as const,
      }));

      const { app, job } = await ctx.db.transaction(async (tx) => {
        const [app] = await tx
          .insert(apps)
          .values({
            name: input.name,
            slug: input.slug,
            description: input.description || null,
            livekitUrl: input.livekitUrl,
            roomPrefix: input.roomPrefix || null,
            enabledServices: input.enabledServices,
            provisioningStatus: "pending",
          })
          .returning();

        await tx.insert(appMembers).values({
          appId: app.id,
          userId: ctx.user!.sub,
          role: "owner",
        });

        const [job] = await tx
          .insert(provisioningJobs)
          .values({
            appId: app.id,
            jobType: "provision",
            status: "pending",
            steps,
          })
          .returning();

        return { app, job };
      });

      // Fire-and-forget provisioning (import dynamically to avoid circular deps)
      const { runProvisioningJob } = await import("./services/provisioner.js");
      runProvisioningJob({
        appId: app.id,
        jobId: job.id,
        slug: app.slug,
        name: app.name,
        description: app.description,
        enabledServices: input.enabledServices as ServiceKey[],
        livekitUrl: input.livekitUrl,
        roomPrefix: input.roomPrefix || null,
      }).catch((err) => log.error("Provisioning failed", { error: String(err) }));

      log.info("App created, provisioning started", { slug: app.slug, jobId: job.id });
      return { app, jobId: job.id };
    }),

  // ── Update app ────────────────────────────────────────────────
  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const { id, ...updates } = input;
      await assertAppMembership(ctx, id, { requireOwner: true });
      const [updated] = await ctx.db
        .update(apps)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(apps.id, id))
        .returning();
      return updated;
    }),

  // ── Delete app ────────────────────────────────────────────────
  delete: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");

      const rows = await ctx.db.select().from(apps).where(eq(apps.id, input.id)).limit(1);
      const app = rows[0];
      if (!app) throw new Error("App not found");

      // Reject delete if provisioning is still in progress
      if (app.provisioningStatus === "provisioning") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Cannot delete app while provisioning is in progress. Wait for provisioning to complete or fail, then retry.",
        });
      }

      // Create deletion job
      const { runDeletionJob } = await import("./services/provisioner.js");
      await runDeletionJob(input.id);

      log.info("App deletion started", { slug: app.slug });
      return { success: true };
    }),

  // ── Get provisioning job ──────────────────────────────────────
  getProvisioningJob: appScopedProcedure
    .input(z.object({ appId: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return null;
      const rows = await ctx.db
        .select()
        .from(provisioningJobs)
        .where(eq(provisioningJobs.appId, input.appId))
        .orderBy(provisioningJobs.createdAt)
        .limit(1);
      return rows[0] || null;
    }),

  // ── Retry provisioning ────────────────────────────────────────
  retryProvisioning: adminProcedure
    .input(z.object({ jobId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const { retryProvisioningJob } = await import("./services/provisioner.js");
      await retryProvisioningJob(input.jobId);
      return { success: true };
    }),
});
