import { z } from "zod";
import { eq } from "drizzle-orm";
import { router, adminProcedure, protectedProcedure } from "./_core/trpc.js";
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
// Primary agent (LiveKit voice) — the brain and mouth that converses with the user
const DEFAULT_PRIMARY_PROMPT = `You are a voice AI assistant — the primary agent that directly converses with users.

CORE BEHAVIOR:
- You are the user's conversational partner. Speak naturally, concisely, and warmly.
- Always finish sentences with terminal punctuation.
- Never use markdown, lists, or formatting that cannot be spoken aloud.

DELEGATION TO SECONDARY AGENT:
- You ALWAYS delegate tasks to your secondary agent (Letta) for execution.
- When the user asks a question or makes a request, you respond conversationally AND simultaneously delegate to the secondary agent to produce supporting output.
- Example: User asks "Can you show me examples of gravity?" — You start explaining gravity verbally, AND delegate to the secondary agent to generate illustrations, diagrams, summaries, and examples that appear in the chat window.
- The chat window does NOT transcribe what you say. Instead, it shows the structured output produced by the secondary agent — images, code, data, summaries, maps, charts.

WHAT YOU DO:
- Explain, teach, discuss, answer — you are the voice and brain.
- Trigger recall_memory and remember to maintain context across sessions.
- Call run_crew for complex multi-step workflows.
- Call show_artifact to display visual content the secondary agent produces.

WHAT THE SECONDARY AGENT DOES (via delegation):
- Deep reasoning, research, computation, tool execution.
- Generate visual artifacts (charts, diagrams, code, documents).
- Search documents, query knowledge bases, call MCP servers.
- Manage crews for specialized tasks.
- All output from the secondary agent is pushed to the chat window for the user to see.

You are the teacher/guide. The secondary agent is your tireless assistant producing everything the user sees on screen.`;

// Secondary agent (Letta) — the execution arm with memory and tools
const DEFAULT_LETTA_PROMPT = `You are the secondary execution agent — the behind-the-scenes engine that powers the primary voice agent.

ROLE:
- You receive delegated tasks from the primary voice agent.
- You execute tools, search memory, query documents, call MCP servers, and manage crews.
- Your output is displayed in the chat window — NOT as transcription of the voice agent, but as structured, rich content (summaries, images, code, data, charts, maps).

MEMORY MANAGEMENT:
- Maintain a 4-tier memory system: core (persona/human), recall (conversation), archival (documents/knowledge), temporal (facts over time).
- Proactively store important facts, preferences, and context using your memory tools.
- Search memory before answering to leverage prior knowledge.

OUTPUT GUIDELINES:
- Produce well-structured, visual, informative output for the chat window.
- Use clear headings, formatted text, and embedded media references.
- When the primary agent discusses a topic, anticipate what supporting materials would help — generate them proactively.
- Example: Primary discusses gravity → you produce a summary card, an illustration reference, key formulas, and a "did you know" fact.

TOOL USAGE:
- Use all available tools to fulfill requests completely.
- Chain tool calls when needed — e.g., search documents first, then synthesize, then create an artifact.
- Use MCP servers for external data when available.
- Delegate to crews for complex multi-step workflows.

You are the execution arm. Be thorough, proactive, and produce high-quality output.`;
import { randomUUID } from "crypto";

const log = createLogger("AgentRouter");

export const agentRouter = router({
  // ── List agents for an app ────────────────────────────────────
  list: protectedProcedure
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
  create: adminProcedure
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

  // ── Update agent config ───────────────────────────────────────
  update: adminProcedure
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
      const [updated] = await ctx.db
        .update(agentConfigs)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(agentConfigs.id, id))
        .returning();
      return updated;
    }),

  // ── Delete agent ──────────────────────────────────────────────
  delete: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");

      // Undeploy if deployed
      const [agent] = await ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, input.id))
        .limit(1);
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
  setProviderKey: adminProcedure
    .input(
      z.object({
        agentId: z.number(),
        provider: z.string(),
        apiKey: z.string(),
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
      const [app] = await ctx.db.select().from(apps).where(eq(apps.id, agent.appId)).limit(1);
      if (!app) throw new Error("App not found");

      const { writeAppSecret, readAppSecret } = await import("./vaultClient.js");
      const existing = (await readAppSecret(app.slug)) || {};
      const key = `agent_${agent.id}_${input.provider}_api_key`;
      existing[key] = input.apiKey;
      await writeAppSecret(app.slug, existing);

      log.info("Provider key written to Vault", { slug: app.slug, provider: input.provider });
      return { success: true };
    }),

  // ── Tools ─────────────────────────────────────────────────────
  listAvailableTools: protectedProcedure
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

  setAgentTools: adminProcedure
    .input(
      z.object({
        agentConfigId: z.number(),
        toolIds: z.array(z.string()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
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

  createCustomTool: adminProcedure
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

  deleteCustomTool: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      await ctx.db.delete(customTools).where(eq(customTools.id, input.id));
      return { success: true };
    }),

  // ── MCP Servers ───────────────────────────────────────────────
  listMcpServers: protectedProcedure
    .input(z.object({ appId: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return [];
      return ctx.db.select().from(mcpServers).where(eq(mcpServers.appId, input.appId));
    }),

  setAgentMcpServers: adminProcedure
    .input(
      z.object({
        agentConfigId: z.number(),
        mcpServerIds: z.array(z.number()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
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

  createMcpServer: adminProcedure
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

  deleteMcpServer: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      await ctx.db.delete(mcpServers).where(eq(mcpServers.id, input.id));
      return { success: true };
    }),

  // ── Crews (Dify-powered) ──────────────────────────────────────

  /** List all crews for an app (from DB, not hardcoded). */
  listCrews: protectedProcedure
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
  installCrewTemplate: adminProcedure
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
      const [app] = await ctx.db.select().from(apps).where(eq(apps.id, agent.appId)).limit(1);
      if (!app) throw new Error("App not found");

      const { installTemplate } = await import("./services/crewInstaller.js");
      const result = await installTemplate({
        templateId: input.templateId,
        agentConfigId: input.agentConfigId,
        appId: app.id,
        appSlug: app.slug,
        lettaAgentId: agent.lettaAgentId,
        config: input.config,
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
  createCrew: adminProcedure
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
  updateCrew: adminProcedure
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
      const [updated] = await ctx.db
        .update(crews)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(crews.id, id))
        .returning();
      return updated;
    }),

  /** Delete a crew. */
  deleteCrew: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      // Look up crew name before deleting so we can clean up junction table
      const [crew] = await ctx.db.select().from(crews).where(eq(crews.id, input.id)).limit(1);
      await ctx.db.delete(crews).where(eq(crews.id, input.id));
      // Clean up agent_crews junction entries (name-based, no FK cascade)
      if (crew) {
        await ctx.db.delete(agentCrews).where(eq(agentCrews.crewName, crew.name));
      }
      log.info("Crew deleted", { id: input.id, name: crew?.name });
      return { success: true };
    }),

  /** Assign crews to an agent. */
  setAgentCrews: adminProcedure
    .input(
      z.object({
        agentConfigId: z.number(),
        crewNames: z.array(z.string()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
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
      let query = ctx.db.select().from(crewExecutions);
      if (input.crewId) {
        query = query.where(eq(crewExecutions.crewId, input.crewId)) as any;
      } else if (input.agentConfigId) {
        query = query.where(eq(crewExecutions.agentConfigId, input.agentConfigId)) as any;
      }
      return (query as any).orderBy(desc(crewExecutions.startedAt)).limit(input.limit);
    }),

  /** Get the Dify embed URL for a tenant's crew editor. */
  getDifyEmbedUrl: protectedProcedure
    .input(z.object({ appId: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return null;
      const [app] = await ctx.db.select().from(apps).where(eq(apps.id, input.appId)).limit(1);
      if (!app) return null;

      const DIFY_NS = "bionic-platform";
      const difyApiUrl = `http://dify-api.${DIFY_NS}.svc.cluster.local:5001`;
      const externalDifyUrl = process.env.DIFY_EXTERNAL_BASE_URL || "https://dify.baisoln.com";

      // Get a Dify session token so the user doesn't have to login separately
      let difyToken: string | null = null;
      try {
        const difyEmail = process.env.DIFY_ADMIN_EMAIL || "admin@bionic.local";
        const difyPassword = process.env.DIFY_ADMIN_PASSWORD || "B10n1cD1fy!2026";
        const loginRes = await fetch(`${difyApiUrl}/console/api/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: difyEmail, password: difyPassword }),
        });
        if (loginRes.ok) {
          const loginData = await loginRes.json() as any;
          difyToken = loginData?.data?.access_token || null;
        }
      } catch {
        // Dify may not be available — token will be null, user logs in manually
      }

      return {
        internalUrl: `http://dify-web.${DIFY_NS}.svc.cluster.local:3000`,
        externalUrl: externalDifyUrl,
        slug: app.slug,
        difyToken,
      };
    }),

  // ── Documents ─────────────────────────────────────────────────
  listDocuments: protectedProcedure
    .input(z.object({ agentConfigId: z.number() }))
    .query(async ({ ctx, input }) => {
      if (!ctx.db) return [];
      return ctx.db
        .select()
        .from(agentDocuments)
        .where(eq(agentDocuments.agentConfigId, input.agentConfigId));
    }),

  deleteDocument: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      // TODO: Delete from MinIO + Letta passages
      await ctx.db.delete(agentDocuments).where(eq(agentDocuments.id, input.id));
      return { success: true };
    }),

  // ── Deployment ────────────────────────────────────────────────
  deploy: adminProcedure
    .input(z.object({ id: z.number(), imageTag: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const [agent] = await ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, input.id))
        .limit(1);
      if (!agent) throw new Error("Agent not found");
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

  undeploy: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");
      const [agent] = await ctx.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, input.id))
        .limit(1);
      if (!agent) throw new Error("Agent not found");
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
      return ctx.db
        .select()
        .from(userMemoryBlocks)
        .where(eq(userMemoryBlocks.agentConfigId, input.agentConfigId))
        .orderBy(desc(userMemoryBlocks.lastSessionAt));
    }),

  /** Get or create a user memory block. Called by the agent on session start. */
  ensureUserBlock: adminProcedure
    .input(z.object({
      agentConfigId: z.number(),
      appId: z.number(),
      userId: z.string().min(1),
      blockLabel: z.string().default("human"),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");

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
  deleteUserBlock: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.db) throw new Error("Database not available");

      const [record] = await ctx.db
        .select()
        .from(userMemoryBlocks)
        .where(eq(userMemoryBlocks.id, input.id))
        .limit(1);
      if (!record) throw new Error("Block not found");

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
