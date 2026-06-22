/**
 * Embed tRPC router — admin-facing CRUD for embed tokens.
 *
 * Each embed token grants anonymous access to a single deployed agent
 * via the public /api/embed/* endpoints. Tokens are scoped per-agent,
 * carry feature toggles (voice, chat, video, screen share, avatar),
 * and can be revoked independently.
 */
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { randomBytes } from "crypto";
import { router, protectedProcedure, assertAppMembership } from "./_core/trpc.js";
import { createLogger } from "./_core/logger.js";
import { embedTokens, agentConfigs } from "../drizzle/platformSchema.js";

const log = createLogger("EmbedRouter");

function generateToken(): string {
  return randomBytes(32).toString("hex"); // 64 hex chars
}

export const embedRouter = router({
  /** List all embed tokens for a specific agent. */
  listByAgent: protectedProcedure
    .input(z.object({ agentId: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [agent] = await ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, input.agentId))
        .limit(1);
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });

      await assertAppMembership(ctx, agent.appId);

      return ctx.db
        .select()
        .from(embedTokens)
        .where(eq(embedTokens.agentConfigId, input.agentId))
        .orderBy(embedTokens.createdAt);
    }),

  /** Create a new embed token for an agent. */
  create: protectedProcedure
    .input(
      z.object({
        agentConfigId: z.number(),
        label: z.string().max(100).optional(),
        allowVoice: z.boolean().optional(),
        allowChat: z.boolean().optional(),
        allowVideo: z.boolean().optional(),
        allowScreenShare: z.boolean().optional(),
        allowAvatar: z.boolean().optional(),
        showTranscription: z.boolean().optional(),
        theme: z.enum(["light", "dark"]).optional(),
        mode: z.enum(["popup", "iframe"]).optional(),
        allowedOrigins: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [agent] = await ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, input.agentConfigId))
        .limit(1);
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });

      await assertAppMembership(ctx, agent.appId);

      const token = generateToken();
      const [row] = await ctx.db
        .insert(embedTokens)
        .values({
          agentConfigId: input.agentConfigId,
          appId: agent.appId,
          token,
          label: input.label ?? "default",
          allowVoice: input.allowVoice ?? true,
          allowChat: input.allowChat ?? true,
          allowVideo: input.allowVideo ?? false,
          allowScreenShare: input.allowScreenShare ?? false,
          allowAvatar: input.allowAvatar ?? false,
          showTranscription: input.showTranscription ?? true,
          theme: input.theme ?? "light",
          mode: input.mode ?? "popup",
          allowedOrigins: input.allowedOrigins ?? [],
        })
        .returning();

      log.info("Embed token created", {
        id: row.id,
        agentId: input.agentConfigId,
        appId: agent.appId,
        label: row.label,
      });

      return row;
    }),

  /** Update an existing embed token's config. */
  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        label: z.string().max(100).optional(),
        allowVoice: z.boolean().optional(),
        allowChat: z.boolean().optional(),
        allowVideo: z.boolean().optional(),
        allowScreenShare: z.boolean().optional(),
        allowAvatar: z.boolean().optional(),
        showTranscription: z.boolean().optional(),
        theme: z.enum(["light", "dark"]).optional(),
        mode: z.enum(["popup", "iframe"]).optional(),
        allowedOrigins: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [existing] = await ctx.db
        .select()
        .from(embedTokens)
        .where(eq(embedTokens.id, input.id))
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Embed token not found" });

      await assertAppMembership(ctx, existing.appId);

      const { id, ...updates } = input;
      // Filter out undefined values
      const cleanUpdates = Object.fromEntries(
        Object.entries(updates).filter(([_, v]) => v !== undefined),
      );

      if (Object.keys(cleanUpdates).length === 0) {
        return existing;
      }

      const [updated] = await ctx.db
        .update(embedTokens)
        .set(cleanUpdates)
        .where(eq(embedTokens.id, id))
        .returning();

      return updated;
    }),

  /** Soft-revoke: set isActive to false. Token remains in DB for audit. */
  revoke: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [existing] = await ctx.db
        .select()
        .from(embedTokens)
        .where(eq(embedTokens.id, input.id))
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Embed token not found" });

      await assertAppMembership(ctx, existing.appId);

      const [updated] = await ctx.db
        .update(embedTokens)
        .set({ isActive: false })
        .where(eq(embedTokens.id, input.id))
        .returning();

      log.info("Embed token revoked", { id: input.id, token: existing.token.slice(0, 8) + "..." });
      return updated;
    }),

  /** Hard delete an embed token. */
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      const [existing] = await ctx.db
        .select()
        .from(embedTokens)
        .where(eq(embedTokens.id, input.id))
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Embed token not found" });

      await assertAppMembership(ctx, existing.appId);

      await ctx.db.delete(embedTokens).where(eq(embedTokens.id, input.id));

      log.info("Embed token deleted", { id: input.id });
      return { success: true };
    }),
});
