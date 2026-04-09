import { z } from "zod";
import { eq } from "drizzle-orm";
import { router, adminProcedure, protectedProcedure, analystOrAdminProcedure, appScopedProcedure, assertAppMembership } from "./_core/trpc.js";
import { TRPCError } from "@trpc/server";
import { appMembers } from "../drizzle/platformSchema.js";
import { createLogger } from "./_core/logger.js";
import {
  agentConfigs,
  agentTools,
  agentMcpServers,
  agentCrews,
  agentDocuments,
  customTools,
  mcpServers,
  apps,
  crews,
  crewExecutions,
  userMemoryBlocks,
} from "../drizzle/platformSchema.js";
import { and } from "drizzle-orm";
import { AVAILABLE_CREWS } from "../shared/providerOptions.js";
import { desc } from "drizzle-orm";

// ── Default System Prompts ──────────────────────────────────────
// Primary agent (LiveKit voice) — the "Professor" giving the lecture.
// Secondary agent (Letta) — the "Assistant" managing the screen, presentation,
// summaries, illustrations, and crew-driven research. Only the assistant
// publishes to the chat window. The professor only speaks.
const DEFAULT_PRIMARY_PROMPT = `You are the PROFESSOR — a voice-only lecturer. You speak; an off-screen
ASSISTANT manages the screen. You have ONE tool: delegate_to_letta.

CALL delegate_to_letta(task) for ANY of: research, web/doc lookup, crew
runs, computation, "show/find/look up X", recalling prior sessions, or
displaying a specific artifact. You have no other tools.

Every sentence you speak is auto-forwarded to the assistant in the
background — it prepares supporting visuals without you asking.

When a tool returns: do NOT read it aloud (it's already on screen).
Give a brief verbal cue like "I've put that on screen" and continue.

VOICE: warm, conversational, 1–2 sentences usually. Terminal punctuation.
No markdown, lists, code, URLs, or long numbers — they can't be spoken.`;

// Secondary agent (Letta) — the silent ASSISTANT managing the screen.
const DEFAULT_LETTA_PROMPT = `You are the ASSISTANT — the silent helper running the screen behind a live
lecture. You never speak. Your only output channel is the chat window.

INPUT:
- "[Live transcript — Professor/Student]: …" → passive context, may react
- Plain user messages → explicit assignment from the professor, must produce

OUTPUT:
- Markdown slides for the screen. Brief, structured, reading-optimized.
- Bullet summaries, definitions, formulas, examples, comparison tables.
- For research: clear answer with sources.
- Skip the "I am the assistant…" preamble. Get straight to the content.

PROACTIVITY:
- React to every meaningful professor turn — topic intros (title + 3–5
  bullets + a hook), explanations (summary card + example), names/terms
  (brief definition).
- Silent on conversational filler ("hello", "thanks") — output nothing,
  the system filters short replies.

TOOLS:
- run_crew: Dify crew for complex research / multi-step workflows.
- archival_memory_search, conversation_search: prior session context.

You are the second brain in a two-brain teaching system. The professor
speaks. You run the screen. Keep up.`;
import { randomUUID } from "crypto";

const log = createLogger("AgentRouter");

export const agentRouter = router({
  // ── List agents for an app ────────────────────────────────────
  list: appScopedProcedure
    .input(z.object({ appId: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return [];
      return ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.appId, input.appId))
        .orderBy(agentConfigs.createdAt);
    }),

  // ── Get single agent with all relations ───────────────────────
  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return null;
      const [agent] = await ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, input.id))
        .limit(1);
      if (!agent) return null;
      if (ctx.user!.role !== "admin") {
        const m = await ctx.db
          .select({ id: appMembers.id })
          .from(appMembers)
          .where(and(eq(appMembers.appId, agent.appId), eq(appMembers.userId, ctx.user!.sub)))
          .limit(1);
        if (m.length === 0) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Not a member of this app" });
        }
      }

      const [tools, mcpLinks, crews, docs] = await Promise.all([
        ctx.db.select().from(agentTools).where(eq(agentTools.agentConfigId, input.id)),
        ctx.db
          .select({
            mcpServerId: agentMcpServers.mcpServerId,
            enabled: agentMcpServers.enabled,
            name: mcpServers.name,
            url: mcpServers.url,
          })
          .from(agentMcpServers)
          .innerJoin(mcpServers, eq(agentMcpServers.mcpServerId, mcpServers.id))
          .where(eq(agentMcpServers.agentConfigId, input.id)),
        ctx.db.select().from(agentCrews).where(eq(agentCrews.agentConfigId, input.id)),
        ctx.db.select().from(agentDocuments).where(eq(agentDocuments.agentConfigId, input.id)),
      ]);

      return {
        ...agent,
        tools: tools.map((t) => ({ toolId: t.toolId, enabled: t.enabled })),
        mcpServers: mcpLinks,
        crews: crews.map((c) => ({ crewName: c.crewName, enabled: c.enabled })),
        documents: docs,
      };
    }),

  // ── Create agent ──────────────────────────────────────────────
  create: appScopedProcedure
    .input(
      z.object({
        appId: z.number(),
        name: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
        description: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");

      // Get app slug for Letta agent name
      const [app] = await ctx.db.select().from(apps).where(eq(apps.id, input.appId)).limit(1);
      if (!app) throw new Error("App not found");

      const lettaAgentName = `${app.slug}-letta-${randomUUID().slice(0, 8)}`;

      const [agent] = await ctx.db
        .insert(agentConfigs)
        .values({
          appId: input.appId,
          name: input.name,
          description: input.description || null,
          lettaAgentName,
          systemPrompt: DEFAULT_PRIMARY_PROMPT,
          lettaSystemPrompt: DEFAULT_LETTA_PROMPT,
        })
        .returning();

      // Auto-select all core tools by default
      const { BUILTIN_TOOLS } = await import("./services/toolRegistry.js");
      const coreToolIds = BUILTIN_TOOLS.map((t) => t.id);
      if (coreToolIds.length > 0) {
        await ctx.db.insert(agentTools).values(
          coreToolIds.map((toolId) => ({ agentConfigId: agent.id, toolId })),
        );
      }

      log.info("Agent created with default tools", { appSlug: app.slug, agentName: input.name, tools: coreToolIds.length });
      return agent;
    }),

  /**
   * Provision (or re-sync) the Letta secondary agent for an existing
   * agent_configs row. Idempotent:
   * - If lettaAgentId is empty in the DB → call lettaAdmin.createAgent,
   *   save the returned id, attach the user-memory + crew tools.
   * - If lettaAgentId is set → call lettaAdmin.updateAgent to push the
   *   current lettaSystemPrompt + lettaLlmModel to the existing Letta
   *   agent (use this to sync prompt/model changes without recreating).
   *
   * Either way, also calls syncCrewTool to refresh the run_crew tool
   * source code (the crew registry is baked into the function body).
   */
  provisionLetta: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const [agent] = await ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, input.id))
        .limit(1);
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      await assertAppMembership(ctx, agent.appId);

      const { lettaAdmin } = await import("./services/lettaAdmin.js");
      const model = agent.lettaLlmModel || "openai-proxy/qwen3.5-27b-fp8";
      const systemPrompt = agent.lettaSystemPrompt || "";
      const name = agent.lettaAgentName || `${agent.name}-letta`;

      let lettaAgentId = agent.lettaAgentId || "";

      if (!lettaAgentId) {
        // First-time provisioning: create the Letta agent.
        const created = await lettaAdmin.createAgent(name, model, systemPrompt);
        lettaAgentId = created.id;
        await ctx.db
          .update(agentConfigs)
          .set({ lettaAgentId, updatedAt: new Date() })
          .where(eq(agentConfigs.id, agent.id));
        log.info("Provisioned Letta agent", { id: agent.id, lettaAgentId });
      } else {
        // Re-sync existing agent's prompt + model.
        await lettaAdmin.updateAgent(lettaAgentId, { system: systemPrompt, model });
        log.info("Re-synced Letta agent", { id: agent.id, lettaAgentId });
      }

      // Refresh the run_crew tool source so any new/changed crews are
      // available immediately.
      try {
        const assignedCrews = await ctx.db
          .select()
          .from(agentCrews)
          .where(eq(agentCrews.agentConfigId, agent.id));
        if (assignedCrews.length > 0) {
          const appCrews = await ctx.db
            .select()
            .from(crews)
            .where(eq(crews.appId, agent.appId));
          const crewRegistry = appCrews
            .filter((c) => assignedCrews.some((ac) => ac.crewName === c.name))
            .filter((c) => c.difyAppApiKey)
            .map((c) => ({
              name: c.name,
              difyAppApiKey: c.difyAppApiKey!,
              mode: c.mode,
            }));
          if (crewRegistry.length > 0) {
            await lettaAdmin.syncCrewTool(lettaAgentId, crewRegistry);
          }
        }
      } catch (err) {
        log.warn("Failed to sync crew tool during provision (non-fatal)", { error: String(err) });
      }

      return { lettaAgentId };
    }),

  // ── Update agent config ───────────────────────────────────────
  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().optional(),
        sttProvider: z.string().optional(),
        sttModel: z.string().nullable().optional(),
        llmProvider: z.string().optional(),
        llmModel: z.string().nullable().optional(),
        ttsProvider: z.string().optional(),
        ttsVoice: z.string().nullable().optional(),
        systemPrompt: z.string().nullable().optional(),
        visionEnabled: z.boolean().optional(),
        avatarEnabled: z.boolean().optional(),
        backgroundAudioEnabled: z.boolean().optional(),
        captureMode: z.string().optional(),
        captureInterval: z.number().optional(),
        lettaAgentName: z.string().nullable().optional(),
        lettaLlmModel: z.string().nullable().optional(),
        lettaSystemPrompt: z.string().nullable().optional(),
        imageTag: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const { id, ...updates } = input;
      const [existing] = await ctx.db.select().from(agentConfigs).where(eq(agentConfigs.id, id)).limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      await assertAppMembership(ctx, existing.appId);

      // Validate llm_model against the live provider /v1/models list when
      // either llmModel OR llmProvider is being changed. Stops the
      // recurring "user types a model id that doesn't exist on the
      // provider, voice loop hangs forever, no clear error" failure mode.
      // Skipped for gpu-ai (internal cluster — no /v1/models we want to
      // round-trip per save) and skipped if the new value is null/empty.
      const newProvider = (updates.llmProvider ?? existing.llmProvider ?? "").toLowerCase();
      const newModel = updates.llmModel === undefined ? existing.llmModel : updates.llmModel;
      const providerOrModelChanged =
        updates.llmProvider !== undefined || updates.llmModel !== undefined;
      if (
        providerOrModelChanged &&
        newModel &&
        newProvider &&
        newProvider !== "gpu-ai" &&
        newProvider !== "custom"
      ) {
        try {
          const { isSupportedProvider, listModelsForProvider } = await import(
            "./services/llmProviders.js"
          );
          if (isSupportedProvider(newProvider)) {
            // Reuse the per-agent key already in Vault if there is one.
            const [app] = await ctx.db.select().from(apps).where(eq(apps.id, existing.appId)).limit(1);
            if (app) {
              const { readAppSecret } = await import("./vaultClient.js");
              const vault = (await readAppSecret(app.slug)) || {};
              const apiKey = vault[`agent_${existing.id}_${newProvider}_api_key`];
              if (apiKey) {
                const models = await listModelsForProvider(newProvider, apiKey);
                const ids = new Set(models.map((m) => m.id));
                if (!ids.has(newModel)) {
                  // Build a short suggestion list — closest matches by
                  // substring of the typed name. Helps the user pick the
                  // right slug without us pulling in a fuzzy-match dep.
                  const needle = newModel.toLowerCase();
                  const hints = models
                    .map((m) => m.id)
                    .filter((mid) => {
                      const lower = mid.toLowerCase();
                      const tokens = needle
                        .split(/[\s\-_/.]+/)
                        .filter((t) => t.length >= 3);
                      return tokens.some((t) => lower.includes(t));
                    })
                    .slice(0, 8);
                  throw new TRPCError({
                    code: "BAD_REQUEST",
                    message:
                      `Model '${newModel}' is not available on ${newProvider}.` +
                      (hints.length > 0
                        ? ` Did you mean one of: ${hints.join(", ")}?`
                        : ` Run agentsCrud.listProviderModels to see what is available.`),
                  });
                }
                log.info("Validated llm_model against provider", {
                  provider: newProvider,
                  model: newModel,
                });
              } else {
                log.warn("Skipping model validation — no provider key in Vault", {
                  provider: newProvider,
                });
              }
            }
          }
        } catch (err) {
          if (err instanceof TRPCError) throw err;
          log.warn("Model validation failed (non-fatal)", { error: String(err) });
        }
      }

      // Validate tts_voice against the live voice list when either
      // ttsVoice OR ttsProvider is being changed. Same protection as
      // llm_model — stops the user from saving a voice ID that doesn't
      // exist on the chosen TTS provider.
      const newTtsProvider = (updates.ttsProvider ?? existing.ttsProvider ?? "").toLowerCase();
      const newTtsVoice = updates.ttsVoice === undefined ? existing.ttsVoice : updates.ttsVoice;
      const ttsChanged =
        updates.ttsProvider !== undefined || updates.ttsVoice !== undefined;
      if (
        ttsChanged &&
        newTtsVoice &&
        newTtsProvider &&
        newTtsProvider !== "gpu-ai" &&
        newTtsProvider !== "custom"
      ) {
        try {
          const { isSupportedVoiceProvider, listVoicesForProvider } = await import(
            "./services/voiceProviders.js"
          );
          if (isSupportedVoiceProvider(newTtsProvider)) {
            const [app2] = await ctx.db.select().from(apps).where(eq(apps.id, existing.appId)).limit(1);
            if (app2) {
              const { readAppSecret } = await import("./vaultClient.js");
              const vault = (await readAppSecret(app2.slug)) || {};
              const apiKey = vault[`agent_${existing.id}_${newTtsProvider}_api_key`];
              if (apiKey) {
                const voices = await listVoicesForProvider(newTtsProvider, apiKey);
                const ids = new Set(voices.map((v) => v.id));
                if (!ids.has(newTtsVoice)) {
                  // Build a short suggestion list — voices that name-match the typed value.
                  const needle = newTtsVoice.toLowerCase();
                  const hints = voices
                    .filter((v) => (v.name || v.id).toLowerCase().includes(needle.slice(0, 5)))
                    .slice(0, 5)
                    .map((v) => `${v.id}${v.name ? ` (${v.name})` : ""}`);
                  throw new TRPCError({
                    code: "BAD_REQUEST",
                    message:
                      `Voice '${newTtsVoice}' is not available on ${newTtsProvider}.` +
                      (hints.length
                        ? ` Did you mean: ${hints.join(", ")}?`
                        : ` Run agentsCrud.listProviderVoices to see what is available.`),
                  });
                }
                log.info("Validated tts_voice against provider", {
                  provider: newTtsProvider,
                  voice: newTtsVoice,
                });
              } else {
                log.warn("Skipping voice validation — no provider key in Vault", {
                  provider: newTtsProvider,
                });
              }
            }
          }
        } catch (err) {
          if (err instanceof TRPCError) throw err;
          log.warn("Voice validation failed (non-fatal)", { error: String(err) });
        }
      }

      const [updated] = await ctx.db
        .update(agentConfigs)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(agentConfigs.id, id))
        .returning();
      return updated;
    }),

  // ── Delete agent ──────────────────────────────────────────────
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");

      // Undeploy if deployed
      const [agent] = await ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, input.id))
        .limit(1);
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      await assertAppMembership(ctx, agent.appId);
      if (agent?.deployed) {
        try {
          const { undeployAgent } = await import("./services/agentDeployer.js");
          const [app] = await ctx.db.select().from(apps).where(eq(apps.id, agent.appId)).limit(1);
          if (app) await undeployAgent(app.slug, agent.name);
        } catch (err) {
          log.warn("Failed to undeploy agent during delete", { error: String(err) });
        }
      }

      await ctx.db.delete(agentConfigs).where(eq(agentConfigs.id, input.id));
      log.info("Agent deleted", { id: input.id });
      return { success: true };
    }),

  // ── Set provider API key (writes to Vault) ────────────────────
  setProviderKey: protectedProcedure
    .input(
      z.object({
        agentId: z.number(),
        provider: z.string(),
        apiKey: z.string().min(8),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const [agent] = await ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, input.agentId))
        .limit(1);
      if (!agent) throw new Error("Agent not found");
      await assertAppMembership(ctx, agent.appId);
      const [app] = await ctx.db.select().from(apps).where(eq(apps.id, agent.appId)).limit(1);
      if (!app) throw new Error("App not found");

      // Trim whitespace defensively — copy-paste from a UI often picks up
      // leading/trailing spaces and providers reject those keys outright.
      const trimmedKey = input.apiKey.trim();

      // Validate the key by hitting the provider's list endpoint:
      //  - LLM providers (openai, openrouter, gpu-ai): /v1/models
      //  - TTS providers (cartesia, elevenlabs, openai): /voices
      //  - STT providers (deepgram): /projects (auth check + static list)
      // Throws TRPCError on auth failure so the UI shows a real error
      // before persisting to Vault.
      const { listModelsForProvider, isSupportedProvider } = await import(
        "./services/llmProviders.js"
      );
      const { listVoicesForProvider, isSupportedVoiceProvider } = await import(
        "./services/voiceProviders.js"
      );

      let count = 0;
      let modelsOrVoices: any[] = [];
      if (isSupportedProvider(input.provider)) {
        const models = await listModelsForProvider(input.provider, trimmedKey);
        count = models.length;
        modelsOrVoices = models;
      } else if (isSupportedVoiceProvider(input.provider)) {
        const voices = await listVoicesForProvider(input.provider, trimmedKey);
        count = voices.length;
        modelsOrVoices = voices;
      } else {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Provider '${input.provider}' is not supported for key validation`,
        });
      }

      const { writeAppSecret, readAppSecret } = await import("./vaultClient.js");
      const existing = (await readAppSecret(app.slug)) || {};
      const key = `agent_${agent.id}_${input.provider}_api_key`;
      existing[key] = trimmedKey;
      await writeAppSecret(app.slug, existing);

      log.info("Provider key validated and written to Vault", {
        slug: app.slug,
        provider: input.provider,
        count,
      });
      return { success: true, modelCount: count, models: modelsOrVoices };
    }),

  /**
   * List voices/STT models for a TTS or STT provider. Same flow as
   * listProviderModels but uses voiceProviders.ts (cartesia, elevenlabs,
   * openai TTS, deepgram). Errors with FAILED_PRECONDITION if the
   * provider doesn't have a known voice list.
   */
  listProviderVoices: protectedProcedure
    .input(
      z.object({
        agentId: z.number(),
        provider: z.string(),
        apiKey: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return { voices: [], hasKey: false as const };
      const [agent] = await ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, input.agentId))
        .limit(1);
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      await assertAppMembership(ctx, agent.appId);

      const { listVoicesForProvider, isSupportedVoiceProvider } = await import(
        "./services/voiceProviders.js"
      );
      // gpu-ai TTS uses static voice IDs (Sudhir-IndexTTS2 etc.) and is
      // not in the voiceProviders table — let the UI fall back to a
      // small static list.
      if (!isSupportedVoiceProvider(input.provider)) {
        return { voices: [], hasKey: false as const, supported: false as const };
      }
      let apiKey = input.apiKey;
      if (!apiKey) {
        const [app] = await ctx.db.select().from(apps).where(eq(apps.id, agent.appId)).limit(1);
        if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
        const { readAppSecret } = await import("./vaultClient.js");
        const vault = (await readAppSecret(app.slug)) || {};
        apiKey = vault[`agent_${agent.id}_${input.provider}_api_key`];
      }
      if (!apiKey) {
        return { voices: [], hasKey: false as const, supported: true as const };
      }
      const voices = await listVoicesForProvider(input.provider, apiKey);
      return { voices, hasKey: true as const, supported: true as const };
    }),

  /**
   * List available models for a provider — pulls live from the provider's
   * /v1/models endpoint using the saved key. Used by the Agent Builder
   * model dropdown so users always see what's actually available.
   *
   * If apiKey is supplied directly, uses it (validation flow before save).
   * Otherwise reads the saved per-agent key from Vault.
   */
  listProviderModels: protectedProcedure
    .input(
      z.object({
        agentId: z.number(),
        provider: z.string(),
        apiKey: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return { models: [] };
      const [agent] = await ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, input.agentId))
        .limit(1);
      if (!agent) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      await assertAppMembership(ctx, agent.appId);

      const { listModelsForProvider, providerNeedsApiKey } = await import(
        "./services/llmProviders.js"
      );

      let apiKey = input.apiKey;
      if (!apiKey) {
        const [app] = await ctx.db.select().from(apps).where(eq(apps.id, agent.appId)).limit(1);
        if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
        const { readAppSecret } = await import("./vaultClient.js");
        const vault = (await readAppSecret(app.slug)) || {};
        apiKey = vault[`agent_${agent.id}_${input.provider}_api_key`];
      }
      // gpu-ai is internal cluster — no key needed.
      if (!apiKey && providerNeedsApiKey(input.provider)) {
        return { models: [], hasKey: false as const };
      }
      const models = await listModelsForProvider(input.provider, apiKey || "");
      return { models, hasKey: true as const };
    }),

  // ── Tools ─────────────────────────────────────────────────────
  listAvailableTools: appScopedProcedure
    .input(z.object({ appId: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return [];
      const { BUILTIN_TOOLS } = await import("./services/toolRegistry.js");
      const custom = await ctx.db
        .select()
        .from(customTools)
        .where(eq(customTools.appId, input.appId));

      return [
        ...BUILTIN_TOOLS.map((t) => ({ ...t, source: "builtin" as const })),
        ...custom.map((t) => ({ ...t, source: "custom" as const })),
      ];
    }),

  setAgentTools: protectedProcedure
    .input(
      z.object({
        agentConfigId: z.number(),
        toolIds: z.array(z.string()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const [a] = await ctx.db.select({ appId: agentConfigs.appId }).from(agentConfigs).where(eq(agentConfigs.id, input.agentConfigId)).limit(1);
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      await assertAppMembership(ctx, a.appId);
      // Delete existing, insert new
      await ctx.db.delete(agentTools).where(eq(agentTools.agentConfigId, input.agentConfigId));
      if (input.toolIds.length > 0) {
        await ctx.db.insert(agentTools).values(
          input.toolIds.map((toolId) => ({
            agentConfigId: input.agentConfigId,
            toolId,
          })),
        );
      }
      return { success: true };
    }),

  createCustomTool: appScopedProcedure
    .input(
      z.object({
        appId: z.number(),
        name: z.string().min(1).max(100),
        description: z.string().optional(),
        toolType: z.enum(["letta", "mcp", "http"]),
        definition: z.record(z.unknown()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const [tool] = await ctx.db
        .insert(customTools)
        .values({
          appId: input.appId,
          name: input.name,
          description: input.description || null,
          toolType: input.toolType,
          definition: input.definition,
        })
        .returning();
      return tool;
    }),

  deleteCustomTool: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const [t] = await ctx.db.select({ appId: customTools.appId }).from(customTools).where(eq(customTools.id, input.id)).limit(1);
      if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "Tool not found" });
      await assertAppMembership(ctx, t.appId);
      await ctx.db.delete(customTools).where(eq(customTools.id, input.id));
      return { success: true };
    }),

  // ── MCP Servers ───────────────────────────────────────────────
  listMcpServers: appScopedProcedure
    .input(z.object({ appId: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return [];
      return ctx.db.select().from(mcpServers).where(eq(mcpServers.appId, input.appId));
    }),

  setAgentMcpServers: protectedProcedure
    .input(
      z.object({
        agentConfigId: z.number(),
        mcpServerIds: z.array(z.number()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const [a] = await ctx.db.select({ appId: agentConfigs.appId }).from(agentConfigs).where(eq(agentConfigs.id, input.agentConfigId)).limit(1);
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      await assertAppMembership(ctx, a.appId);
      await ctx.db
        .delete(agentMcpServers)
        .where(eq(agentMcpServers.agentConfigId, input.agentConfigId));
      if (input.mcpServerIds.length > 0) {
        await ctx.db.insert(agentMcpServers).values(
          input.mcpServerIds.map((mcpServerId) => ({
            agentConfigId: input.agentConfigId,
            mcpServerId,
          })),
        );
      }
      return { success: true };
    }),

  createMcpServer: appScopedProcedure
    .input(
      z.object({
        appId: z.number(),
        name: z.string().min(1).max(100),
        url: z.string().url(),
        transport: z.enum(["streamable-http", "sse"]).default("streamable-http"),
        authType: z.enum(["none", "api-key", "bearer"]).default("none"),
        description: z.string().optional(),
        apiKey: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const { apiKey, ...serverData } = input;

      const [server] = await ctx.db
        .insert(mcpServers)
        .values({
          ...serverData,
          description: serverData.description || null,
        })
        .returning();

      // Store API key in Vault if provided
      if (apiKey && input.authType !== "none") {
        const [app] = await ctx.db.select().from(apps).where(eq(apps.id, input.appId)).limit(1);
        if (app) {
          const { writeAppSecret, readAppSecret } = await import("./vaultClient.js");
          const existing = (await readAppSecret(app.slug)) || {};
          existing[`mcp_${input.name}_api_key`] = apiKey;
          await writeAppSecret(app.slug, existing);
        }
      }

      return server;
    }),

  deleteMcpServer: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const [s] = await ctx.db.select({ appId: mcpServers.appId }).from(mcpServers).where(eq(mcpServers.id, input.id)).limit(1);
      if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "MCP server not found" });
      await assertAppMembership(ctx, s.appId);
      await ctx.db.delete(mcpServers).where(eq(mcpServers.id, input.id));
      return { success: true };
    }),

  // ── Crews (Dify-powered) ──────────────────────────────────────

  /** List all crews for an app (from DB, not hardcoded). */
  listCrews: appScopedProcedure
    .input(z.object({ appId: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return [];
      return ctx.db
        .select()
        .from(crews)
        .where(eq(crews.appId, input.appId))
        .orderBy(crews.createdAt);
    }),

  /** Get available crew templates for one-click install. */
  listCrewTemplates: protectedProcedure.query(async () => {
    const { listTemplates } = await import("./services/crewTemplateLoader.js");
    return listTemplates();
  }),

  /**
   * Platform-level one-shot setup for the crew templates feature:
   *  - Writes the Search MCP API key to Vault (platform/search-mcp)
   *  - Creates the platform-wide Keycloak realm roles "Admin" and "Analyst"
   *    (idempotent — safe to re-run)
   *  - Reports which env vars are still missing for full functionality
   */
  setupCrewPlatform: adminProcedure
    .input(
      z.object({
        searchMcpApiKey: z.string().min(20).optional(),
        notifyWebhookToken: z.string().min(8).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const result: {
        vault: string;
        keycloak: string[];
        envChecks: Record<string, boolean>;
      } = {
        vault: "skipped",
        keycloak: [],
        envChecks: {},
      };

      // 1. Vault — write the platform Search MCP key (if provided)
      if (input.searchMcpApiKey) {
        const { writePlatformSecret, readPlatformSecret } = await import(
          "./vaultClient.js"
        );
        const existing = (await readPlatformSecret("search-mcp")) || {};
        existing.api_key = input.searchMcpApiKey;
        await writePlatformSecret("search-mcp", existing);
        result.vault = "wrote secret/data/platform/search-mcp";
      }
      if (input.notifyWebhookToken) {
        const { writePlatformSecret, readPlatformSecret } = await import(
          "./vaultClient.js"
        );
        const existing = (await readPlatformSecret("notify")) || {};
        existing.webhook_token = input.notifyWebhookToken;
        await writePlatformSecret("notify", existing);
      }

      // 2. Keycloak realm roles
      try {
        const { createRealmRole } = await import("./services/keycloakAdmin.js");
        await createRealmRole("Admin", "Platform administrator (full access)");
        await createRealmRole(
          "Analyst",
          "Analyst — can install and run crew templates, no admin",
        );
        result.keycloak.push("Admin", "Analyst");
      } catch (err) {
        log.warn("Keycloak role provisioning failed", { error: String(err) });
        result.keycloak = [];
      }

      // 3. Env-var sanity report (does not throw — just informs the caller)
      result.envChecks = {
        MAIL_FROM: Boolean(process.env.MAIL_FROM),
        LETTA_BASE_URL: Boolean(process.env.LETTA_BASE_URL),
        DIFY_ADMIN_EMAIL: Boolean(process.env.DIFY_ADMIN_EMAIL),
        DIFY_ADMIN_PASSWORD: Boolean(process.env.DIFY_ADMIN_PASSWORD),
        VAULT_ADDR: Boolean(process.env.VAULT_ADDR),
        VAULT_TOKEN: Boolean(process.env.VAULT_TOKEN),
        BIONIC_INTERNAL_BASE_URL: Boolean(process.env.BIONIC_INTERNAL_BASE_URL),
      };

      log.info("Crew platform setup complete", result);
      return result;
    }),

  /**
   * One-click install a crew template into Dify and register it as a crew
   * for the given agent. Reuses the platform admin SSO to Dify, so the user
   * does not need to paste any API keys.
   */
  installCrewTemplate: analystOrAdminProcedure
    .input(
      z.object({
        agentConfigId: z.number(),
        templateId: z.string(),
        config: z.record(z.string()).default({}),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");

      // Look up the agent + its app (slug, lettaAgentId).
      const [agent] = await ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, input.agentConfigId))
        .limit(1);
      if (!agent) throw new Error("Agent not found");
      // Cross-app write gate: analystOrAdminProcedure only checks the realm
      // role, not membership. Without this, any Analyst could install a crew
      // template into any app's agent if they know the agentConfigId.
      await assertAppMembership(ctx, agent.appId);
      const [app] = await ctx.db.select().from(apps).where(eq(apps.id, agent.appId)).limit(1);
      if (!app) throw new Error("App not found");

      // Reinstall path: if a crew with this template id already exists for
      // this app, capture its difyAppId so the installer can delete the
      // orphan Dify app + Vault key before re-importing. Without this we'd
      // accumulate dead Dify apps and stale keys on every re-install.
      const [existingCrew] = await ctx.db
        .select()
        .from(crews)
        .where(and(eq(crews.appId, app.id), eq(crews.name, input.templateId)))
        .limit(1);

      const { installTemplate } = await import("./services/crewInstaller.js");
      const result = await installTemplate({
        templateId: input.templateId,
        agentConfigId: input.agentConfigId,
        appId: app.id,
        appSlug: app.slug,
        lettaAgentId: agent.lettaAgentId,
        config: input.config,
        previousDifyAppId: existingCrew?.difyAppId || null,
      });

      // Insert the crews row.
      const crewName = result.template.metadata.id;
      const [crew] = await ctx.db
        .insert(crews)
        .values({
          appId: app.id,
          name: crewName,
          description: result.template.metadata.description,
          difyAppId: result.difyAppId,
          difyAppApiKey: result.difyApiKey,
          mode: result.template.metadata.mode,
          isTemplate: false,
          config: input.config,
        })
        .onConflictDoUpdate({
          target: [crews.appId, crews.name],
          set: {
            difyAppId: result.difyAppId,
            difyAppApiKey: result.difyApiKey,
            description: result.template.metadata.description,
            mode: result.template.metadata.mode,
            config: input.config,
            updatedAt: new Date(),
          },
        })
        .returning();

      // Link to the agent (idempotent).
      await ctx.db
        .insert(agentCrews)
        .values({ agentConfigId: input.agentConfigId, crewName })
        .onConflictDoNothing();

      log.info("Crew template installed", {
        templateId: input.templateId,
        agentConfigId: input.agentConfigId,
        crewId: crew.id,
        difyAppId: result.difyAppId,
        postInstallStarted: result.postInstallStarted,
      });

      return {
        crew,
        postInstallStarted: result.postInstallStarted,
      };
    }),

  /** Legacy: list available crews (backward compat). */
  listAvailableCrews: protectedProcedure
    .input(z.object({ appId: z.number() }).optional())
    .query(async ({ ctx, input }) => {
      if (!ctx.db || !input?.appId) return AVAILABLE_CREWS;
      // Membership check: optional input means callers can pass nothing to get
      // the global default list, but the moment they pass an appId we treat
      // it as app-scoped and require membership.
      await assertAppMembership(ctx, input.appId);
      const appCrews = await ctx.db
        .select()
        .from(crews)
        .where(eq(crews.appId, input.appId));
      if (appCrews.length === 0) return AVAILABLE_CREWS;
      return appCrews.map((c) => ({
        id: c.id,
        name: c.name,
        label: c.name.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()),
        description: c.description || "",
        difyAppId: c.difyAppId,
        mode: c.mode,
        isTemplate: c.isTemplate,
      }));
    }),

  /** Create a new crew (registers a Dify workflow). */
  createCrew: appScopedProcedure
    .input(
      z.object({
        appId: z.number(),
        name: z.string().min(1).max(100).regex(/^[a-z0-9_]+$/),
        description: z.string().optional(),
        difyAppId: z.string().optional(),
        difyWorkflowId: z.string().optional(),
        difyAppApiKey: z.string().optional(),
        mode: z.enum(["workflow", "agent-chat", "completion"]).default("workflow"),
        isTemplate: z.boolean().default(false),
        config: z.record(z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const [crew] = await ctx.db
        .insert(crews)
        .values({
          appId: input.appId,
          name: input.name,
          description: input.description || null,
          difyAppId: input.difyAppId || null,
          difyWorkflowId: input.difyWorkflowId || null,
          difyAppApiKey: input.difyAppApiKey || null,
          mode: input.mode,
          isTemplate: input.isTemplate,
          config: input.config || null,
        })
        .returning();

      // Store Dify API key in Vault if provided
      if (input.difyAppApiKey) {
        const [app] = await ctx.db.select().from(apps).where(eq(apps.id, input.appId)).limit(1);
        if (app) {
          const { writeAppSecret, readAppSecret } = await import("./vaultClient.js");
          const existing = (await readAppSecret(app.slug)) || {};
          existing[`dify_crew_${input.name}_api_key`] = input.difyAppApiKey;
          await writeAppSecret(app.slug, existing);
        }
      }

      log.info("Crew created", { appId: input.appId, name: input.name });
      return crew;
    }),

  /** Update a crew. */
  updateCrew: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().optional(),
        description: z.string().optional(),
        difyAppId: z.string().optional(),
        difyWorkflowId: z.string().optional(),
        difyAppApiKey: z.string().optional(),
        mode: z.string().optional(),
        config: z.record(z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const { id, ...updates } = input;
      const [c] = await ctx.db.select({ appId: crews.appId }).from(crews).where(eq(crews.id, id)).limit(1);
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Crew not found" });
      await assertAppMembership(ctx, c.appId);
      const [updated] = await ctx.db
        .update(crews)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(crews.id, id))
        .returning();
      return updated;
    }),

  /** Delete a crew. */
  deleteCrew: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      // Look up crew name before deleting so we can clean up junction table
      const [crew] = await ctx.db.select().from(crews).where(eq(crews.id, input.id)).limit(1);
      if (!crew) throw new TRPCError({ code: "NOT_FOUND", message: "Crew not found" });
      await assertAppMembership(ctx, crew.appId);
      await ctx.db.delete(crews).where(eq(crews.id, input.id));
      // Clean up agent_crews junction entries (name-based, no FK cascade)
      if (crew) {
        await ctx.db.delete(agentCrews).where(eq(agentCrews.crewName, crew.name));
      }
      log.info("Crew deleted", { id: input.id, name: crew?.name });
      return { success: true };
    }),

  /** Assign crews to an agent. */
  setAgentCrews: protectedProcedure
    .input(
      z.object({
        agentConfigId: z.number(),
        crewNames: z.array(z.string()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const [a] = await ctx.db.select({ appId: agentConfigs.appId }).from(agentConfigs).where(eq(agentConfigs.id, input.agentConfigId)).limit(1);
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      await assertAppMembership(ctx, a.appId);
      await ctx.db.delete(agentCrews).where(eq(agentCrews.agentConfigId, input.agentConfigId));
      if (input.crewNames.length > 0) {
        await ctx.db.insert(agentCrews).values(
          input.crewNames.map((crewName) => ({
            agentConfigId: input.agentConfigId,
            crewName,
          })),
        );
      }
      return { success: true };
    }),

  /** Get crew execution history. */
  listCrewExecutions: protectedProcedure
    .input(z.object({
      crewId: z.number().optional(),
      agentConfigId: z.number().optional(),
      limit: z.number().min(1).max(100).default(20),
    }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return [];
      // Resolve appId from whichever id was passed and gate on membership.
      // Without this, knowing/guessing a crewId or agentConfigId from another
      // app exposes its execution history (IDOR).
      let appId: number | null = null;
      if (input.crewId) {
        const [c] = await ctx.db.select({ appId: crews.appId }).from(crews).where(eq(crews.id, input.crewId)).limit(1);
        if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Crew not found" });
        appId = c.appId;
      } else if (input.agentConfigId) {
        const [a] = await ctx.db.select({ appId: agentConfigs.appId }).from(agentConfigs).where(eq(agentConfigs.id, input.agentConfigId)).limit(1);
        if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
        appId = a.appId;
      } else {
        throw new TRPCError({ code: "BAD_REQUEST", message: "crewId or agentConfigId required" });
      }
      await assertAppMembership(ctx, appId);
      let query = ctx.db.select().from(crewExecutions);
      if (input.crewId) {
        query = query.where(eq(crewExecutions.crewId, input.crewId)) as any;
      } else if (input.agentConfigId) {
        query = query.where(eq(crewExecutions.agentConfigId, input.agentConfigId)) as any;
      }
      return (query as any).orderBy(desc(crewExecutions.startedAt)).limit(input.limit);
    }),

  /** Get the Dify embed URL for a tenant's crew editor.
   *
   *  SECURITY: Previously this also returned a Dify admin session token
   *  obtained by logging in as the platform-wide Dify admin user. That
   *  token grants full Dify console access across ALL tenants/apps —
   *  any single-app member could pivot to Dify admin via the token.
   *  The client never actually consumed it (it just opens /dify-login
   *  in a new tab), so it has been removed entirely. If we ever need
   *  per-app SSO into Dify it must be a per-user, per-app scoped token,
   *  not the global admin credential. */
  getDifyEmbedUrl: appScopedProcedure
    .input(z.object({ appId: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return null;
      const [app] = await ctx.db.select().from(apps).where(eq(apps.id, input.appId)).limit(1);
      if (!app) return null;

      const DIFY_NS = "bionic-platform";
      const externalDifyUrl = process.env.DIFY_EXTERNAL_BASE_URL || "https://dify.baisoln.com";

      return {
        internalUrl: `http://dify-web.${DIFY_NS}.svc.cluster.local:3000`,
        externalUrl: externalDifyUrl,
        slug: app.slug,
      };
    }),

  // ── Documents ─────────────────────────────────────────────────
  listDocuments: protectedProcedure
    .input(z.object({ agentConfigId: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return [];
      const [a] = await ctx.db.select({ appId: agentConfigs.appId }).from(agentConfigs).where(eq(agentConfigs.id, input.agentConfigId)).limit(1);
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      await assertAppMembership(ctx, a.appId);
      return ctx.db
        .select()
        .from(agentDocuments)
        .where(eq(agentDocuments.agentConfigId, input.agentConfigId));
    }),

  deleteDocument: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const [d] = await ctx.db
        .select({ appId: agentConfigs.appId })
        .from(agentDocuments)
        .innerJoin(agentConfigs, eq(agentDocuments.agentConfigId, agentConfigs.id))
        .where(eq(agentDocuments.id, input.id))
        .limit(1);
      if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
      await assertAppMembership(ctx, d.appId);
      // TODO: Delete from MinIO + Letta passages
      await ctx.db.delete(agentDocuments).where(eq(agentDocuments.id, input.id));
      return { success: true };
    }),

  // ── Deployment ────────────────────────────────────────────────
  deploy: protectedProcedure
    .input(z.object({ id: z.number(), imageTag: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const [agent] = await ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, input.id))
        .limit(1);
      if (!agent) throw new Error("Agent not found");
      await assertAppMembership(ctx, agent.appId);
      const [app] = await ctx.db.select().from(apps).where(eq(apps.id, agent.appId)).limit(1);
      if (!app) throw new Error("App not found");

      // Update status
      await ctx.db
        .update(agentConfigs)
        .set({
          deployed: true,
          deploymentStatus: "deploying",
          imageTag: input.imageTag || agent.imageTag,
          lastDeployedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(agentConfigs.id, input.id));

      // Fire-and-forget deployment
      const { deployAgent } = await import("./services/agentDeployer.js");
      deployAgent(ctx.db, app, agent).catch((err) => {
        log.error("Agent deployment failed", { error: String(err) });
        ctx.db!
          .update(agentConfigs)
          .set({ deploymentStatus: "failed", updatedAt: new Date() })
          .where(eq(agentConfigs.id, input.id))
          .catch(() => {});
      });

      return { success: true };
    }),

  undeploy: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const [agent] = await ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, input.id))
        .limit(1);
      if (!agent) throw new Error("Agent not found");
      await assertAppMembership(ctx, agent.appId);
      const [app] = await ctx.db.select().from(apps).where(eq(apps.id, agent.appId)).limit(1);
      if (!app) throw new Error("App not found");

      const { undeployAgent } = await import("./services/agentDeployer.js");
      await undeployAgent(app.slug, agent.name);

      await ctx.db
        .update(agentConfigs)
        .set({ deployed: false, deploymentStatus: "stopped", updatedAt: new Date() })
        .where(eq(agentConfigs.id, input.id));

      return { success: true };
    }),

  getDeploymentStatus: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return null;
      const [agent] = await ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, input.id))
        .limit(1);
      if (!agent) return null;
      await assertAppMembership(ctx, agent.appId);
      const [app] = await ctx.db.select().from(apps).where(eq(apps.id, agent.appId)).limit(1);
      if (!app) return { status: agent.deploymentStatus, replicas: 0, message: "App not found" };

      try {
        const { getAgentStatus } = await import("./services/agentDeployer.js");
        return getAgentStatus(app.slug, agent.name);
      } catch {
        return { status: agent.deploymentStatus, replicas: 0, message: "Unable to check status" };
      }
    }),

  // ── User Memory Blocks (per-user isolation) ──────────────────

  /** List all user memory blocks for an agent. */
  listUserMemoryBlocks: protectedProcedure
    .input(z.object({ agentConfigId: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return [];
      const [a] = await ctx.db.select({ appId: agentConfigs.appId }).from(agentConfigs).where(eq(agentConfigs.id, input.agentConfigId)).limit(1);
      if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      await assertAppMembership(ctx, a.appId);
      return ctx.db
        .select()
        .from(userMemoryBlocks)
        .where(eq(userMemoryBlocks.agentConfigId, input.agentConfigId))
        .orderBy(desc(userMemoryBlocks.lastSessionAt));
    }),

  /** Get or create a user memory block. Called by the agent on session start. */
  ensureUserBlock: appScopedProcedure
    .input(z.object({
      agentConfigId: z.number(),
      appId: z.number(),
      userId: z.string().min(1),
      blockLabel: z.string().default("human"),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");

      // SECURITY: bind input.userId to the caller's Keycloak sub. Without
      // this, any same-app member could pass another user's sub and create
      // a Letta block under their identity (horizontal privilege escalation
      // within the app). Admins bypass — they may legitimately need to
      // pre-create blocks for other users.
      if (ctx.user!.role !== "admin" && input.userId !== ctx.user!.sub) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "userId must match the caller's sub (or admin role required)",
        });
      }

      // Check if block already exists
      const [existing] = await ctx.db
        .select()
        .from(userMemoryBlocks)
        .where(
          and(
            eq(userMemoryBlocks.agentConfigId, input.agentConfigId),
            eq(userMemoryBlocks.userId, input.userId),
            eq(userMemoryBlocks.blockLabel, input.blockLabel),
          ),
        )
        .limit(1);

      if (existing) {
        // Update last session timestamp
        await ctx.db
          .update(userMemoryBlocks)
          .set({ lastSessionAt: new Date() })
          .where(eq(userMemoryBlocks.id, existing.id));
        return existing;
      }

      // Create a new Letta block for this user
      const { lettaAdmin } = await import("./services/lettaAdmin.js");
      const block = await lettaAdmin.createBlock(
        input.blockLabel,
        `User: ${input.userId}\nPreferences: (none yet)\nContext: (new session)`,
        { limit: 20000, description: `Per-user ${input.blockLabel} block for ${input.userId}` },
      );

      // Register in DB
      const [record] = await ctx.db
        .insert(userMemoryBlocks)
        .values({
          appId: input.appId,
          agentConfigId: input.agentConfigId,
          userId: input.userId,
          blockLabel: input.blockLabel,
          lettaBlockId: block.id,
          lastSessionAt: new Date(),
        })
        .returning();

      log.info("Created user memory block", { userId: input.userId, blockId: block.id });
      return record;
    }),

  /** Delete a user's memory block (admin cleanup). */
  deleteUserBlock: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");

      const [record] = await ctx.db
        .select()
        .from(userMemoryBlocks)
        .where(eq(userMemoryBlocks.id, input.id))
        .limit(1);
      if (!record) throw new Error("Block not found");
      await assertAppMembership(ctx, record.appId);

      // Delete from Letta
      try {
        const { lettaAdmin } = await import("./services/lettaAdmin.js");
        await lettaAdmin.deleteBlock(record.lettaBlockId);
      } catch (err) {
        log.warn("Failed to delete Letta block", { blockId: record.lettaBlockId, error: String(err) });
      }

      // Delete from DB
      await ctx.db.delete(userMemoryBlocks).where(eq(userMemoryBlocks.id, input.id));
      return { success: true };
    }),
});
