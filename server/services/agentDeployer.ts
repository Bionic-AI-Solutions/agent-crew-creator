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

// ── Letta tool source code loader ────────────────────────────────
const TOOL_SOURCE_DIR = new URL("../letta-tools/", import.meta.url).pathname;

async function loadToolSourceCode(toolName: string): Promise<string | null> {
  try {
    const fs = await import("fs/promises");
    const path = `${TOOL_SOURCE_DIR}${toolName}.py`;
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

function getToolPipRequirements(toolName: string): { name: string }[] {
  const reqs: Record<string, { name: string }[]> = {
    code_interpreter: [],
    generate_pdf: [{ name: "reportlab" }, { name: "minio" }],
    generate_image: [],
    web_search: [],
    run_crew: [{ name: "requests" }],
  };
  return reqs[toolName] || [];
}

/**
 * Map an llmProvider value (lowercase) to the conventional SDK env var.
 * Used to inject the per-agent API key from Vault into the worker pod.
 * gpu-ai is intentionally excluded — internal cluster GPU has no auth.
 */
function providerEnvName(provider: string): string | null {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "deepgram":
      return "DEEPGRAM_API_KEY";
    case "cartesia":
      return "CARTESIA_API_KEY";
    case "elevenlabs":
      return "ELEVENLABS_API_KEY";
    case "groq":
      return "GROQ_API_KEY";
    case "async":
      return "ASYNC_API_KEY";
    default:
      return null;
  }
}

const AGENT_IMAGE = process.env.AGENT_TEMPLATE_IMAGE || "docker4zerocool/bionic-agent:latest";
// All internal cluster URLs — agents run inside the cluster, no need for external hops
const LETTA_MCP_URL = process.env.LETTA_INTERNAL_URL
  ? `${process.env.LETTA_INTERNAL_URL}/mcp`
  : "http://letta-server.letta.svc.cluster.local:8283/mcp";
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "minio-tenant-hl.minio.svc.cluster.local:9000";
const LANGFUSE_HOST = process.env.LANGFUSE_INTERNAL_URL || "http://langfuse-web.langfuse.svc.cluster.local:3000";
const GPU_AI_MCP_URL = process.env.GPU_AI_MCP_INTERNAL_URL || "http://mcp-ai-mcp-server.mcp.svc.cluster.local:8009/mcp";
// OpenAI-compatible LLM/STT/TTS endpoint — different from the MCP server above.
const GPU_AI_LLM_URL = process.env.GPU_AI_LLM_INTERNAL_URL || "http://mcp-api-server.mcp.svc.cluster.local:8000";
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
      .select({
        name: mcpServers.name,
        url: mcpServers.url,
        transport: mcpServers.transport,
        command: mcpServers.command,
        args: mcpServers.args,
        env: mcpServers.env,
        headers: mcpServers.headers,
        authType: mcpServers.authType,
      })
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
    AGENT_CONFIG_ID: String(agent.id),

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
    LETTA_SERVER_PASSWORD: "",  // Populated below from shared Vault

    // ── Infrastructure URLs (internal cluster) ──────────────────
    LIVEKIT_URL: LIVEKIT_INTERNAL_URL,
    LETTA_MCP_URL: LETTA_MCP_URL,
    LETTA_BASE_URL: LETTA_MCP_URL.replace("/mcp", ""),
    GPU_AI_MCP_URL: GPU_AI_MCP_URL,
    GPU_AI_LLM_URL: GPU_AI_LLM_URL,
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
    BUSY_AUDIO_ENABLED: String((agent as any).busyAudioEnabled ?? false),
    AMBIENT_AUDIO_URL: "",  // Populated below with presigned URL if audio file exists
    THINKING_AUDIO_URL: "",  // Populated below with presigned URL if audio file exists
    CAPTURE_MODE: agent.captureMode,
    CAPTURE_INTERVAL_SECONDS: String(agent.captureInterval || 5),
    BITHUMAN_AVATAR_IMAGE: "",  // Populated below with presigned URL if avatar image exists
    BITHUMAN_API_URL: "http://192.168.0.10:8089/launch",
    MCP_SERVERS: JSON.stringify(mcpLinks.map((m) => {
      const config: Record<string, any> = { name: m.name, transport: m.transport };
      if (m.url) config.url = m.url;
      if (m.command) config.command = m.command;
      if (m.args) { try { config.args = JSON.parse(m.args); } catch { config.args = [m.args]; } }
      if (m.env) { try { config.env = JSON.parse(m.env); } catch {} }
      if (m.headers) { try { config.headers = JSON.parse(m.headers); } catch {} }
      return config;
    })),
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

  // 3b. Sync ALL enabled tools to Letta agent
  if (agent.lettaAgentId) {
    try {
      const { lettaAdmin } = await import("./lettaAdmin.js");
      const { BUILTIN_TOOLS } = await import("./toolRegistry.js");

      // Get current Letta agent tools and all available Letta tools
      const [agentLettaTools, allLettaTools] = await Promise.all([
        lettaAdmin.getAgentTools(agent.lettaAgentId),
        lettaAdmin.listTools(),
      ]);
      const currentToolNames = new Set((agentLettaTools as any[]).map((t: any) => t.name));

      // Build set of desired Letta tool names from enabled agent_tools
      const enabledToolIds = new Set(tools.filter((t) => t.enabled).map((t) => t.toolId));
      const desiredLettaNames = new Set<string>();
      for (const bt of BUILTIN_TOOLS) {
        if (bt.lettaToolName && enabledToolIds.has(bt.id)) {
          desiredLettaNames.add(bt.lettaToolName);
        }
      }

      // Build lookup: Letta tool name → Letta tool ID
      const lettaToolByName = new Map<string, string>();
      for (const lt of allLettaTools as any[]) {
        lettaToolByName.set(lt.name, lt.id);
      }

      // Attach missing tools — auto-create from source code if not on Letta server
      for (const name of desiredLettaNames) {
        if (!currentToolNames.has(name)) {
          let lettaId = lettaToolByName.get(name);

          // Auto-create tool if source code is available
          if (!lettaId) {
            const sourceCode = await loadToolSourceCode(name);
            if (sourceCode) {
              try {
                const bt = BUILTIN_TOOLS.find((b) => b.lettaToolName === name);
                const created = await lettaAdmin.createTool(sourceCode, {
                  description: bt?.description,
                  tags: ["builtin", name],
                  pipRequirements: getToolPipRequirements(name),
                });
                lettaId = created.id;
                lettaToolByName.set(name, lettaId);
                log.info("Auto-created Letta tool from source", { tool: name, lettaId });
              } catch (createErr) {
                log.warn("Failed to create Letta tool", { tool: name, error: String(createErr) });
              }
            } else {
              log.warn("Tool not found on Letta server and no source code available", { tool: name });
            }
          }

          if (lettaId) {
            await lettaAdmin.attachToolToAgent(agent.lettaAgentId, lettaId);
            log.info("Attached tool to Letta agent", { tool: name, lettaId });
          }
        }
      }

      // Detach tools that were removed (skip core Letta tools like memory_*)
      const coreLettaTools = new Set(["memory_replace", "memory_insert", "conversation_search", "archival_memory_search", "archival_memory_insert"]);
      for (const existing of agentLettaTools as any[]) {
        if (!desiredLettaNames.has(existing.name) && !coreLettaTools.has(existing.name)) {
          await lettaAdmin.detachToolFromAgent(agent.lettaAgentId, existing.id);
          log.info("Detached tool from Letta agent", { tool: existing.name });
        }
      }

      log.info("Letta tool sync complete", {
        agentId: agent.lettaAgentId,
        desired: [...desiredLettaNames],
        current: [...currentToolNames],
      });
    } catch (err) {
      log.warn("Failed to sync tools to Letta (non-fatal)", { error: String(err) });
    }
  }

  // 4. Resolve Vault secrets BEFORE applying ConfigMap so all values are populated.

  // 4a. Letta server password — shared infrastructure secret.
  try {
    const { readPlatformVaultPath } = await import("../vaultClient.js");
    const infraData = (await readPlatformVaultPath("shared/infra")) || {};
    if (infraData.letta_server_password) {
      configData.LETTA_SERVER_PASSWORD = infraData.letta_server_password;
    }
  } catch (err) {
    log.warn("Failed to read Letta server password from Vault (non-fatal)", { error: String(err) });
  }

  // 4b. ExternalSecret (ConfigMap written AFTER presigned URLs are generated below)
  await k8s.createExternalSecret(namespace);

  // 5. Resolve per-agent provider API keys from Vault — for ALL three
  // pipelines (LLM, STT, TTS). setProviderKey writes per-agent keys to
  // Vault as `agent_${id}_${provider}_api_key`. Look up each pipeline's
  // configured provider, find the matching key, inject it as the
  // SDK-standard {PROVIDER}_API_KEY env var on the worker pod.
  //
  // Deduped: a single provider used for two pipelines (e.g. openai for
  // both STT and TTS) only gets one env var injection.
  const extraEnv: Array<{ name: string; value: string }> = [];
  const injected = new Set<string>();
  try {
    const { readAppSecret, readPlatformVaultPath } = await import("../vaultClient.js");
    const vault = (await readAppSecret(app.slug)) || {};

    // Load shared fallback keys (secret/shared/api-keys) once — used when
    // per-agent keys are not configured. This allows agents to work out of
    // the box with shared org-wide keys while still supporting per-agent
    // overrides via the UI's "Test & Save" flow.
    let sharedKeys: Record<string, string> = {};
    try {
      sharedKeys = (await readPlatformVaultPath("shared/api-keys")) || {};
    } catch {
      log.info("No shared API keys found at secret/shared/api-keys");
    }

    const pipelines: Array<["llm" | "stt" | "tts", string | null]> = [
      ["llm", agent.llmProvider],
      ["stt", agent.sttProvider],
      ["tts", agent.ttsProvider],
    ];
    for (const [kind, raw] of pipelines) {
      const provider = (raw || "").toLowerCase();
      if (!provider || provider === "gpu-ai" || provider === "custom") continue;
      const envName = providerEnvName(provider);
      if (!envName) continue;
      if (injected.has(envName)) continue; // already added by another pipeline

      // Priority: per-agent key > shared fallback key
      const perAgentKey = vault[`agent_${agent.id}_${provider}_api_key`];
      const sharedKey = sharedKeys[`${provider}_api_key`];
      const key = perAgentKey || sharedKey;

      if (!key) {
        log.warn("No provider key found (per-agent or shared)", {
          agent: agent.id, pipeline: kind, provider,
        });
        continue;
      }
      extraEnv.push({ name: envName, value: key.trim() });
      injected.add(envName);
      log.info("Injected provider key", {
        agent: agent.id, pipeline: kind, provider, envName,
        source: perAgentKey ? "per-agent" : "shared",
      });
    }
  } catch (err) {
    log.warn("Failed to resolve provider keys (non-fatal)", { error: String(err) });
  }

  // 5c. BitHuman avatar keys — shared across all agents (one GPU server).
  // These live at secret/shared/bithuman, not per-app.
  if (agent.avatarEnabled) {
    try {
      const { readPlatformVaultPath } = await import("../vaultClient.js");
      const bhData = (await readPlatformVaultPath("shared/bithuman")) || {};
      if (bhData.bithuman_api_key) {
        extraEnv.push({ name: "BITHUMAN_API_KEY", value: bhData.bithuman_api_key });
      }
      if (bhData.bithuman_api_secret) {
        extraEnv.push({ name: "BITHUMAN_API_SECRET", value: bhData.bithuman_api_secret });
      }
      log.info("Injected BitHuman keys from shared Vault", { agentId: agent.id });
    } catch (err) {
      log.warn("Failed to read BitHuman keys from shared Vault (non-fatal)", { error: String(err) });
    }

    // Generate a presigned URL for the avatar image so the agent pod can
    // fetch it over HTTP. The MinIO path is stored in DB as "bucket/key".
    if (agent.avatarImageUrl) {
      try {
        const { getClient } = await import("./minioAdmin.js");
        const client = await getClient();
        const [bucket, ...keyParts] = agent.avatarImageUrl.split("/");
        const key = keyParts.join("/");
        const presignedUrl = await client.presignedGetObject(bucket, key, 7 * 24 * 60 * 60);
        configData.BITHUMAN_AVATAR_IMAGE = presignedUrl;
        log.info("Generated presigned avatar URL", { agentId: agent.id, bucket, key });
      } catch (err) {
        log.warn("Failed to generate presigned avatar URL (non-fatal)", { error: String(err) });
      }
    }
  }

  // 5c. Generate presigned URLs for audio files (ambient/thinking sounds)
  for (const audioField of ["ambientAudioUrl", "thinkingAudioUrl"] as const) {
    const minioPath = (agent as any)[audioField];
    if (minioPath) {
      try {
        const { getClient } = await import("./minioAdmin.js");
        const client = await getClient();
        const [bucket, ...keyParts] = minioPath.split("/");
        const key = keyParts.join("/");
        const presignedUrl = await client.presignedGetObject(bucket, key, 7 * 24 * 60 * 60);
        const configKey = audioField === "ambientAudioUrl" ? "AMBIENT_AUDIO_URL" : "THINKING_AUDIO_URL";
        configData[configKey] = presignedUrl;
        log.info("Generated presigned audio URL", { agentId: agent.id, type: audioField, bucket, key });
      } catch (err) {
        log.warn("Failed to generate presigned audio URL (non-fatal)", { type: audioField, error: String(err) });
      }
    }
  }

  // 6. Write ConfigMap with ALL finalized values (presigned URLs, API keys, etc.)
  await k8s.ensureConfigMap(namespace, configMapName, configData);
  log.info("ConfigMap written with all resolved values", { namespace, configMapName, keys: Object.keys(configData).length });

  // 7. Apply Deployment — just agent-{name} since namespace provides isolation
  await k8s.applyAgentDeployment(namespace, agentName, image, configMapName, secretName, extraEnv);

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
