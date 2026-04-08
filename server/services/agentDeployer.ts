/**
 * Agent deployment to Kubernetes.
 *
 * Agents deploy to their app's namespace ({app-slug}), not a shared namespace.
 * Each app gets its own namespace during provisioning, so agent names only need
 * to be unique within the app — no cross-app collision risk.
 *
 * Creates ConfigMap + ensures ExternalSecret + applies Deployment.
 */
import { eq } from "drizzle-orm";
import { createLogger } from "../_core/logger.js";
import { k8s } from "../k8sClient.js";
import {
  agentConfigs,
  agentTools,
  agentMcpServers,
  agentCrews,
  mcpServers,
  crews,
} from "../../drizzle/platformSchema.js";
import type { Database } from "../db.js";
import type { App, AgentConfig } from "../../drizzle/platformSchema.js";

const log = createLogger("AgentDeployer");

const AGENT_IMAGE = process.env.AGENT_TEMPLATE_IMAGE || "docker4zerocool/bionic-agent:latest";
// All internal cluster URLs — agents run inside the cluster, no need for external hops
const LETTA_MCP_URL = process.env.LETTA_INTERNAL_URL
  ? `${process.env.LETTA_INTERNAL_URL}/mcp`
  : "http://letta-server.letta.svc.cluster.local:8283/mcp";
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "minio-tenant-hl.minio.svc.cluster.local:9000";
const LANGFUSE_HOST = process.env.LANGFUSE_INTERNAL_URL || "http://langfuse-web.langfuse.svc.cluster.local:3000";
const GPU_AI_MCP_URL = process.env.GPU_AI_MCP_INTERNAL_URL || "http://mcp-ai-mcp-server.mcp.svc.cluster.local:8009/mcp";
const LIVEKIT_INTERNAL_URL = process.env.LIVEKIT_INTERNAL_URL || "ws://livekit-server.livekit.svc.cluster.local:7880";

export async function deployAgent(
  db: Database,
  app: App,
  agent: AgentConfig,
): Promise<void> {
  // Deploy to the app's own namespace — each app is isolated
  const namespace = app.slug;
  const agentName = agent.name;
  const configMapName = `${agentName}-config`;
  const secretName = `${namespace}-secrets`; // ExternalSecret created during app provisioning
  const image = `${AGENT_IMAGE.split(":")[0]}:${agent.imageTag || "latest"}`;

  // LiveKit dispatch key — must be unique across the shared LiveKit instance.
  // We share one LiveKit (wss://livekit.bionicaisolutions.com) across all
  // apps, so two apps with agents named the same would collide if we
  // registered with the bare agent.name. Prefix with the app slug.
  const dispatchName = `${app.slug}-${agentName}`;
  log.info("Deploying agent", { namespace, agentName, dispatchName, image });

  // 1. Gather relations from DB
  const [tools, mcpLinks, agentCrewLinks, appCrews] = await Promise.all([
    db.select().from(agentTools).where(eq(agentTools.agentConfigId, agent.id)),
    db
      .select({ name: mcpServers.name, url: mcpServers.url, transport: mcpServers.transport })
      .from(agentMcpServers)
      .innerJoin(mcpServers, eq(agentMcpServers.mcpServerId, mcpServers.id))
      .where(eq(agentMcpServers.agentConfigId, agent.id)),
    db.select().from(agentCrews).where(eq(agentCrews.agentConfigId, agent.id)),
    db.select().from(crews).where(eq(crews.appId, app.id)),
  ]);

  // 2. Build ConfigMap data
  const configData: Record<string, string> = {
    APP_SLUG: app.slug,
    APP_ENV: "production",
    AGENT_NAME: dispatchName,

    // ── Primary brain (fast, user-facing voice LLM) ─────────────
    LLM_PROVIDER: agent.llmProvider,
    LLM_MODEL: agent.llmModel || "gemma-4-e4b",
    STT_PROVIDER: agent.sttProvider,
    STT_MODEL: agent.sttModel || "",
    TTS_PROVIDER: agent.ttsProvider,
    TTS_VOICE: agent.ttsVoice || "Sudhir-IndexTTS2",
    SYSTEM_PROMPT: agent.systemPrompt || "",

    // ── Secondary brain (Letta) ─────────────────────────────────
    LETTA_AGENT_NAME: agent.lettaAgentName || `${app.slug}-letta-${agent.name}`,
    LETTA_AGENT_ID: agent.lettaAgentId || "",
    LETTA_LLM_MODEL: agent.lettaLlmModel || "openai-proxy/qwen3.5-27b-fp8",
    LETTA_SYSTEM_PROMPT: agent.lettaSystemPrompt || "",

    // ── Infrastructure URLs (internal cluster) ──────────────────
    LIVEKIT_URL: LIVEKIT_INTERNAL_URL,
    LETTA_MCP_URL: LETTA_MCP_URL,
    LETTA_BASE_URL: LETTA_MCP_URL.replace("/mcp", ""),
    GPU_AI_MCP_URL: GPU_AI_MCP_URL,
    MINIO_ENDPOINT: MINIO_ENDPOINT,
    MINIO_USE_SSL: "false",
    MINIO_BUCKET: app.slug,
    LANGFUSE_HOST: LANGFUSE_HOST,
    KEYCLOAK_URL: "http://keycloak.keycloak.svc.cluster.local:80",
    DIFY_BASE_URL: `http://dify-api.bionic-platform.svc.cluster.local:5001`,
    DIFY_WEB_URL: `http://dify-web.bionic-platform.svc.cluster.local:3000`,

    // ── Agent features ──────────────────────────────────────────
    VISION_ENABLED: String(agent.visionEnabled),
    AVATAR_ENABLED: String(agent.avatarEnabled),
    BACKGROUND_AUDIO_ENABLED: String(agent.backgroundAudioEnabled),
    CAPTURE_MODE: agent.captureMode,
    CAPTURE_INTERVAL_SECONDS: String(agent.captureInterval || 5),
    MCP_SERVERS: JSON.stringify(mcpLinks.map((m) => ({ name: m.name, url: m.url, transport: m.transport }))),
    ENABLED_CREWS: JSON.stringify(agentCrewLinks.map((c) => c.crewName)),
    CREW_REGISTRY: JSON.stringify(
      appCrews
        .filter((c) => agentCrewLinks.some((ac) => ac.crewName === c.name))
        .map((c) => ({
          name: c.name,
          difyAppId: c.difyAppId,
          difyAppApiKey: c.difyAppApiKey,
          mode: c.mode,
        })),
    ),
  };

  // 3. Sync Letta run_crew tool with current crew registry
  const assignedCrews = appCrews
    .filter((c) => agentCrewLinks.some((ac) => ac.crewName === c.name))
    .filter((c) => c.difyAppApiKey); // only crews with API keys
  if (agent.lettaAgentId && assignedCrews.length > 0) {
    try {
      const { lettaAdmin } = await import("./lettaAdmin.js");
      await lettaAdmin.syncCrewTool(
        agent.lettaAgentId,
        assignedCrews.map((c) => ({
          name: c.name,
          difyAppApiKey: c.difyAppApiKey!,
          mode: c.mode,
        })),
      );
      log.info("Synced Letta run_crew tool", { agentId: agent.lettaAgentId, crews: assignedCrews.length });
    } catch (err) {
      log.warn("Failed to sync Letta run_crew tool (non-fatal)", { error: String(err) });
    }
  }

  // 4. ConfigMap + ExternalSecret in the app's namespace
  await k8s.ensureConfigMap(namespace, configMapName, configData);
  await k8s.createExternalSecret(namespace);

  // 5. Apply Deployment — just agent-{name} since namespace provides isolation
  await k8s.applyAgentDeployment(namespace, agentName, image, configMapName, secretName);

  // 6. Update status to deploying
  await db
    .update(agentConfigs)
    .set({ deploymentStatus: "deploying", updatedAt: new Date() })
    .where(eq(agentConfigs.id, agent.id));

  log.info("Agent deployment applied", { namespace, agentName });

  // 7. Poll K8s until pod is ready, then update status to "running"
  (async () => {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const status = await k8s.getDeploymentStatus(namespace, agentName);
        if (status.status === "running") {
          await db
            .update(agentConfigs)
            .set({ deploymentStatus: "running", updatedAt: new Date() })
            .where(eq(agentConfigs.id, agent.id));
          log.info("Agent pod ready", { namespace, agentName, replicas: status.replicas });
          return;
        }
      } catch {}
    }
    // Timed out — mark as failed
    await db
      .update(agentConfigs)
      .set({ deploymentStatus: "failed", updatedAt: new Date() })
      .where(eq(agentConfigs.id, agent.id));
    log.error("Agent pod did not become ready within 60s", { namespace, agentName });
  })();
}

export async function undeployAgent(appSlug: string, agentName: string): Promise<void> {
  // Agents live in their app's namespace
  await k8s.deleteAgentDeployment(appSlug, agentName);
  log.info("Agent undeployed", { namespace: appSlug, agentName });
}

export async function getAgentStatus(appSlug: string, agentName: string) {
  // Agents live in their app's namespace
  return k8s.getDeploymentStatus(appSlug, agentName);
}
