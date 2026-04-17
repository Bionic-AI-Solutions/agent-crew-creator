/**
 * Playground tRPC router.
 *
 * Mints LiveKit join tokens for testers to connect to a freshly-named room
 * for a specific (app, agent, user) tuple. Server reads LiveKit credentials
 * from Vault per request — never from `apps.apiKey/apiSecret` and never
 * returned to the client.
 *
 * Dispatch model: each token grant carries `RoomConfiguration.agents` with
 * the worker's registered agent_name (= agent.name in the agent_configs
 * row, mirrored into the AGENT_NAME env on the agent pod by agentDeployer).
 * LiveKit auto-dispatches the matching worker into the new room.
 *
 * JWT identity = ctx.user.sub (Keycloak sub) so the agent's
 * swap_user_memory_block keys per real platform user, preserving Letta
 * per-user memory isolation.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { AccessToken } from "livekit-server-sdk";
import { RoomAgentDispatch, RoomConfiguration } from "@livekit/protocol";
import { router, appScopedProcedure, assertAppMembership, protectedProcedure } from "./_core/trpc.js";
import { createLogger } from "./_core/logger.js";
import { apps, agentConfigs } from "../drizzle/platformSchema.js";
import { readAppSecret } from "./vaultClient.js";
import { randomUUID } from "crypto";

const log = createLogger("PlaygroundRouter");

const TOKEN_TTL_SECONDS = 60 * 60; // 1h — long enough for an interactive session

interface VaultLiveKit {
  livekit_api_key: string;
  livekit_api_secret: string;
  livekit_url: string;
}

function pickLiveKit(vault: Record<string, string> | null, slug: string): VaultLiveKit {
  if (!vault) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `No Vault secrets found for app '${slug}' — run provisioning first`,
    });
  }
  const apiKey = vault.livekit_api_key;
  const apiSecret = vault.livekit_api_secret;
  const url = vault.livekit_url;
  if (!apiKey || !apiSecret || !url) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Vault is missing one of livekit_api_key/livekit_api_secret/livekit_url for '${slug}'`,
    });
  }
  return { livekit_api_key: apiKey, livekit_api_secret: apiSecret, livekit_url: url };
}

function shortRand(): string {
  return randomUUID().slice(0, 8);
}

export const playgroundRouter = router({
  /** Non-secret metadata about an app's Playground readiness — for the UI to
   *  decide whether to enable the Connect button and to surface deep-links. */
  getMeta: appScopedProcedure
    .input(z.object({ appId: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [app] = await ctx.db.select().from(apps).where(eq(apps.id, input.appId)).limit(1);
      if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });

      const vault = await readAppSecret(app.slug);
      const livekitReady = Boolean(
        vault?.livekit_api_key && vault?.livekit_api_secret && vault?.livekit_url,
      );

      return {
        appId: app.id,
        slug: app.slug,
        livekitReady,
        livekitUrl: vault?.livekit_url || null, // public WSS URL — not a secret
        langfuseProjectId: vault?.langfuse_project_id || null,
      };
    }),

  /** Mint a LiveKit join token for a (user, app, agent) tuple.
   *  Returns: token, livekitUrl, roomName, expiresAt, identity.
   *  Never returns API secret or langfuse secret. */
  getConnectionBundle: appScopedProcedure
    .input(
      z.object({
        appId: z.number(),
        agentId: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });

      // Resolve app + agent and confirm the agent belongs to the requested app.
      const [app] = await ctx.db.select().from(apps).where(eq(apps.id, input.appId)).limit(1);
      if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });

      const [agent] = await ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, input.agentId))
        .limit(1);
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      if (agent.appId !== app.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Agent does not belong to this app" });
      }
      // appScopedProcedure already checked app membership; this also covers it.
      await assertAppMembership(ctx, app.id);

      if (!agent.deployed) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Agent '${agent.name}' is not deployed — deploy it first from the Agent Builder`,
        });
      }

      // Vault read — single source of truth for LiveKit creds.
      const vault = await readAppSecret(app.slug);
      const lk = pickLiveKit(vault, app.slug);

      // Room name must be unique per session so concurrent testers don't
      // collide. Pattern lets ops grep `kubectl logs` cleanly.
      const userTag = (ctx.user!.sub || "anon").slice(0, 8);
      const roomName = `pg-${app.slug}-${agent.id}-${userTag}-${shortRand()}`;

      // JWT identity must equal the platform user id so the worker's
      // swap_user_memory_block keys per real user (see agent-template
      // main_agent.py:528-565).
      const identity = ctx.user!.sub;
      const displayName = ctx.user!.name || ctx.user!.email || identity;

      const at = new AccessToken(lk.livekit_api_key, lk.livekit_api_secret, {
        identity,
        name: displayName,
        ttl: TOKEN_TTL_SECONDS,
      });
      at.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        // Auto-create the room on join so callers don't need RoomService.
        roomCreate: true,
      });
      // Dispatch the named worker into this fresh room. The worker's
      // AGENT_NAME env is set by agentDeployer to `${slug}-${agent.name}`
      // (slug-prefixed to avoid cross-app collisions on the shared LiveKit
      // instance). We must mirror that exact string here.
      const dispatchName = `${app.slug}-${agent.name}`;
      at.roomConfig = new RoomConfiguration({
        agents: [new RoomAgentDispatch({ agentName: dispatchName })],
      });

      // #region agent log
      const { emitDebugLog } = await import("./debugSessionLog.js");
      emitDebugLog({
        location: "playgroundRouter.ts:getToken",
        message: "playground token roomConfig dispatch",
        hypothesisId: "H3-H5",
        data: {
          agentId: agent.id,
          dbAgentName: agent.name,
          appSlug: app.slug,
          dispatchName,
          k8sDeploymentName: `agent-${agent.name}`,
          roomName,
        },
      });
      // #endregion

      const token = await at.toJwt();
      const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString();

      log.info("Playground token minted", {
        slug: app.slug,
        agentId: agent.id,
        agentName: agent.name,
        roomName,
        userSub: ctx.user!.sub,
      });

      return {
        token,
        livekitUrl: lk.livekit_url,
        roomName,
        identity,
        displayName,
        expiresAt,
        agent: {
          id: agent.id,
          name: agent.name,
          visionEnabled: agent.visionEnabled,
          avatarEnabled: agent.avatarEnabled,
        },
      };
    }),
});
