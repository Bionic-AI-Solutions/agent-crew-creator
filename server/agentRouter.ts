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
} from "../drizzle/platformSchema.js";
import { AVAILABLE_CREWS, DEFAULT_CREW_TEMPLATES } from "../shared/providerOptions.js";
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
        avatarEnabled: z.boolean().optional(),
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

  /** Get available crew templates for import. */
  listCrewTemplates: protectedProcedure.query(() => DEFAULT_CREW_TEMPLATES),

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

      // Dify is a shared platform service in bionic-platform namespace
      const DIFY_NS = "bionic-platform";
      const difyWebUrl = `http://dify-web.${DIFY_NS}.svc.cluster.local:3000`;

      // External URL for browser iframe embedding — proxy through platform HTTPS
      // /dify proxies to the shared Dify instance; append /apps to skip the dashboard
      const externalDifyUrl = process.env.DIFY_EXTERNAL_BASE_URL
        ? `${process.env.DIFY_EXTERNAL_BASE_URL}/apps`
        : `/dify/apps`;

      return {
        internalUrl: difyWebUrl,
        externalUrl: externalDifyUrl,
        slug: app.slug,
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
});
