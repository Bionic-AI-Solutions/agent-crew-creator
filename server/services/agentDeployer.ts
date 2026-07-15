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
import { k8s, VAULT_PROPERTY_OVERRIDES } from "../k8sClient.js";
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
import { signAvatarImageUrl } from "./avatarUrl.js";

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
    generate_persona_image: [],
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
export function providerEnvName(provider: string): string | null {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    case "sarvam":
      return "SARVAM_API_KEY";
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

/**
 * Which key *name* within the per-namespace K8s Secret an env var
 * should reference — the per-agent override if one exists in Vault,
 * else the shared org-wide fallback. Only existence is checked by the
 * caller, never the key's value: the secret material itself flows
 * Vault -> ExternalSecret -> K8s Secret -> secretKeyRef, refreshed on a
 * timer, so rotating a key only requires a pod restart, not a redeploy
 * through this app (see spec addendum, 2026-07-15).
 */
export function resolveProviderSecretKey(
  agentId: number,
  provider: string,
  hasPerAgentKey: boolean,
): string {
  return hasPerAgentKey
    ? `agent_${agentId}_${provider}_api_key`
    : `shared_${provider}_api_key`;
}

/**
 * Whether a provider's shared, org-wide fallback key is present in the
 * already-fetched shared/api-keys map. Reads through
 * VAULT_PROPERTY_OVERRIDES first — imported from k8sClient.ts, the
 * same map buildSharedProviderKeyDataEntries() uses for the
 * ExternalSecret's remoteRef.property — so this existence check and
 * the actual Vault field the ExternalSecret pulls from can never
 * silently disagree about a provider's casing again (they used to be
 * two independent lowercase-template guesses; that's exactly how
 * SARVAM_API_KEY's key delivery broke live on 2026-07-15 despite
 * k8sClient.ts's own override already being correct).
 */
export function hasSharedProviderKey(
  sharedKeys: Record<string, string>,
  provider: string,
): boolean {
  return Boolean(sharedKeys[VAULT_PROPERTY_OVERRIDES[provider] ?? `${provider}_api_key`]);
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
// Shared flashhead-engine for realtime talking-head avatars. Agents
// with avatarEnabled connect here over WebSocket. Default assumes the
// engine is deployed in the `flashhead` namespace.
const FLASHHEAD_ENGINE_URL =
  process.env.FLASHHEAD_ENGINE_URL || "ws://flashhead-engine.flashhead.svc.cluster.local:8080/v1/session";
const FLASHHEAD_DEFAULT_REFERENCE_IMAGE = process.env.FLASHHEAD_DEFAULT_REFERENCE_IMAGE || "";
const BIONIC_INTERNAL_BASE_URL =
  process.env.BIONIC_INTERNAL_BASE_URL || "http://bionic-platform.bionic-platform.svc.cluster.local";

function getAvatarReferenceImage(appSlug: string, agent: AgentConfig): string {
  const referenceImage = (agent as any).avatarReferenceImage || "";
  if (referenceImage.startsWith("data:image/")) {
    return signAvatarImageUrl(BIONIC_INTERNAL_BASE_URL, appSlug, agent.name);
  }
  return referenceImage || FLASHHEAD_DEFAULT_REFERENCE_IMAGE;
}

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
    // Default: Qwen 3.6 35B no-think — best voice latency/quality on
    // gpu-ai. Agents can override per-agent in the UI.
    LLM_PROVIDER: agent.llmProvider,
    // Strip any legacy "openai-proxy/" prefix: it routes through a dead gpu-ai
    // upstream (ai-llm-inference:8001 → 404 → gateway 500) so the agent never
    // gets an LLM reply. The bare model id is what /v1/models serves.
    LLM_MODEL: (agent.llmModel || "qwen3.6-35b-a3b-fp8").replace(/^openai-proxy\//, ""),
    STT_PROVIDER: agent.sttProvider,
    STT_MODEL: agent.sttModel || "",
    TTS_PROVIDER: agent.ttsProvider,
    TTS_VOICE: agent.ttsVoice || "Sudhir-IndexTTS2",
    TTS_LANGUAGE: agent.ttsLanguage || "en-IN",
    SYSTEM_PROMPT: agent.systemPrompt || "",

    // ── Secondary brain (Letta) ─────────────────────────────────
    LETTA_AGENT_NAME: agent.lettaAgentName || `${app.slug}-letta-${agent.name}`,
    LETTA_AGENT_ID: agent.lettaAgentId || "",
    // Letta (executor) defaults to the thinking variant — heavy lifting
    // is done here so CoT pays off.
    LETTA_LLM_MODEL: (agent.lettaLlmModel || "qwen3.6-35b-a3b-fp8-think").replace(/^openai-proxy\//, ""),
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
    // FlashHead is the default avatar engine; bithuman kept as legacy.
    // Per-agent avatar config comes from agent.avatarProvider /
    // avatarReferenceImage if set, else falls back to platform defaults.
    AVATAR_PROVIDER: (agent as any).avatarProvider || "flashhead",
    FLASHHEAD_ENGINE_URL,
    FLASHHEAD_REFERENCE_IMAGE: getAvatarReferenceImage(app.slug, agent),
    FLASHHEAD_AVATAR_NAME: (agent as any).avatarName || agent.name,
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

      // Sync tools — replace built-ins with our custom versions, attach missing
      for (const name of desiredLettaNames) {
        const sourceCode = await loadToolSourceCode(name);

        // If tool is already attached but we have custom source code, check if it needs replacing
        if (currentToolNames.has(name) && sourceCode) {
          const existingTool = (agentLettaTools as any[]).find((t: any) => t.name === name);
          // Replace if existing tool has no source_code (built-in) or different source
          if (existingTool && (!existingTool.source_code || !existingTool.source_code.includes("search-mcp-service"))) {
            try {
              await lettaAdmin.detachToolFromAgent(agent.lettaAgentId, existingTool.id);
              // Don't delete shared tools (they may be used by other agents)
              // Create our custom version with a unique name if needed
              const bt = BUILTIN_TOOLS.find((b) => b.lettaToolName === name);
              const created = await lettaAdmin.createTool(sourceCode, {
                description: bt?.description,
                tags: ["custom", name],
                pipRequirements: getToolPipRequirements(name),
              });
              await lettaAdmin.attachToolToAgent(agent.lettaAgentId, created.id);
              log.info("Replaced built-in tool with custom version", { tool: name, newId: created.id });
            } catch (replaceErr) {
              log.warn("Could not replace built-in tool", { tool: name, error: String(replaceErr) });
            }
          }
          continue; // Already handled
        }

        if (!currentToolNames.has(name)) {
          let lettaId = lettaToolByName.get(name);

          // Auto-create tool from source code if available
          if (!lettaId && sourceCode) {
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
          } else if (!lettaId) {
            log.warn("Tool not found on Letta server and no source code available", { tool: name });
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

      // ── Wire linked MCP servers → Letta agent ──────────────────
      // Register each linked MCP server with Letta (Letta is the upstream that
      // connects out and exposes the server's tools) and attach those tools to
      // the agent. Auth token comes from Vault (mcp_<name>_api_key, written when
      // the server was saved in the UI) and is passed as an Authorization header.
      // Best-effort: a bad URL / stale token logs a warning, never fails deploy.
      if (mcpLinks.length > 0) {
        const { readAppSecret } = await import("../vaultClient.js");
        const mcpSecrets = (await readAppSecret(app.slug)) || {};
        for (const m of mcpLinks) {
          const lettaServerName = `${app.slug}-${m.name}`.replace(/[^A-Za-z0-9_-]/g, "-");
          try {
            // Explicit headers JSON wins; otherwise a bearer/api-key token from
            // Vault becomes an Authorization: Bearer header.
            let customHeaders: Record<string, string> | undefined;
            if (m.headers) {
              try { customHeaders = JSON.parse(m.headers); } catch { /* ignore malformed */ }
            }
            if ((!customHeaders || !Object.keys(customHeaders).length) && m.authType && m.authType !== "none") {
              const token = mcpSecrets[`mcp_${m.name}_api_key`];
              if (token) customHeaders = { Authorization: `Bearer ${token}` };
            }
            let mcpArgs: string[] | undefined;
            let mcpEnv: Record<string, string> | undefined;
            if (m.args) { try { mcpArgs = JSON.parse(m.args); } catch { /* ignore */ } }
            if (m.env) { try { mcpEnv = JSON.parse(m.env); } catch { /* ignore */ } }

            await lettaAdmin.registerMcpServer({
              name: lettaServerName,
              transport: m.transport,
              url: m.url || undefined,
              command: m.command || undefined,
              args: mcpArgs,
              env: mcpEnv,
              customHeaders,
            });
            const mcpTools = await lettaAdmin.listMcpServerTools(lettaServerName);
            let attached = 0;
            for (const t of mcpTools) {
              if (!t?.name) continue;
              const created = await lettaAdmin.registerMcpToolFromServer(lettaServerName, t.name);
              if (created?.id) {
                await lettaAdmin.attachToolToAgent(agent.lettaAgentId, created.id);
                attached++;
              }
            }
            log.info("MCP server wired to Letta agent", { server: lettaServerName, toolsAttached: attached });
          } catch (err) {
            log.warn("MCP server wiring failed (non-fatal) — verify the server URL and auth token in the UI", {
              server: lettaServerName,
              error: String((err as any)?.body?.message || (err as any)?.message || err),
            });
          }
        }
      }

      // Set tool execution environment variables on the Letta agent
      // These are needed by generate_image, generate_pdf, code_interpreter etc.
      try {
        const { readPlatformVaultPath } = await import("../vaultClient.js");
        const { readAppSecret } = await import("../vaultClient.js");
        const appSecrets = (await readAppSecret(app.slug)) || {};
        const sharedApiKeys = (await readPlatformVaultPath("shared/api-keys")) || {};
        const sharedInfra = (await readPlatformVaultPath("shared/infra")) || {};

        const toolEnv: Record<string, string> = {};
        // Gemini API key for generate_image (check api-keys first, then infra)
        const geminiKey = sharedApiKeys.gemini_api_key || sharedInfra.gemini_api_key;
        if (geminiKey) toolEnv.GEMINI_API_KEY = geminiKey;
        // MinIO credentials for file storage (generate_image, generate_pdf)
        if (appSecrets.minio_access_key) toolEnv.MINIO_ACCESS_KEY = appSecrets.minio_access_key;
        if (appSecrets.minio_secret_key) toolEnv.MINIO_SECRET_KEY = appSecrets.minio_secret_key;
        toolEnv.MINIO_BUCKET = app.slug;
        toolEnv.MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "minio-tenant-hl.minio.svc.cluster.local:9000";
        toolEnv.MINIO_PUBLIC_HOST = process.env.MINIO_EXTERNAL_ENDPOINT || "s3.baisoln.com";
        // Letta self-reference for archival memory inserts
        if (appSecrets.letta_api_key) toolEnv.LETTA_API_KEY = appSecrets.letta_api_key;
        toolEnv.LETTA_BASE_URL = process.env.LETTA_BASE_URL || "http://letta-server.letta.svc.cluster.local:8283";
        toolEnv.LETTA_AGENT_ID = agent.lettaAgentId;
        // Search API for web_search tool — use internal K8s service (no API key needed)
        toolEnv.SEARCH_API_URL = "http://search-mcp-service.mcp.svc.cluster.local:8000/search";
        // Platform internal API for generate_persona_image tool (avatar update)
        toolEnv.PLATFORM_API_URL = process.env.PLATFORM_INTERNAL_URL || "http://bionic-platform-server.bionic-platform.svc.cluster.local:3000";
        toolEnv.AGENT_INTERNAL_TOKEN = sharedInfra.agent_internal_token || process.env.AGENT_INTERNAL_TOKEN || "";
        toolEnv.AGENT_CONFIG_ID = String(agent.id);

        if (Object.keys(toolEnv).length > 0) {
          await lettaAdmin.updateAgent(agent.lettaAgentId, {
            tool_exec_environment_variables: toolEnv,
          });
          log.info("Set Letta tool exec env vars", { agentId: agent.lettaAgentId, keys: Object.keys(toolEnv) });
        }
      } catch (envErr) {
        log.warn("Failed to set Letta tool exec env vars (non-fatal)", { error: String(envErr) });
      }
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
  // Ensure the Docker Hub pull secret exists so the agent Deployment's
  // imagePullSecrets reference resolves (private bionic-agent image).
  await k8s.createDockerHubPullSecret(namespace);

  // 5. Resolve per-agent provider API keys from Vault — for ALL three
  // pipelines (LLM, STT, TTS). setProviderKey writes per-agent keys to
  // Vault as `agent_${id}_${provider}_api_key`. Look up each pipeline's
  // configured provider, find the matching key, inject it as the
  // SDK-standard {PROVIDER}_API_KEY env var on the worker pod.
  //
  // Deduped: a single provider used for two pipelines (e.g. openai for
  // both STT and TTS) only gets one env var injection.
  const extraEnv: Array<{ name: string; secretKey: string }> = [];
  const injected = new Set<string>();
  try {
    const { readAppSecret, readPlatformVaultPath } = await import("../vaultClient.js");
    const vault = (await readAppSecret(app.slug)) || {};

    // Load shared fallback keys (secret/shared/api-keys) once — used to
    // check *existence* only (never the value) when deciding whether a
    // pipeline has a per-agent override or falls back to the shared
    // org-wide key. The actual key material is delivered to the pod via
    // ExternalSecret + secretKeyRef (see k8sClient.ts), never resolved
    // or baked into a literal value here — see spec addendum, 2026-07-15.
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

      const hasPerAgentKey = Boolean(vault[`agent_${agent.id}_${provider}_api_key`]);
      // Per-agent keys are always written under the lowercase convention
      // by this app's own "Test & Save" flow, so no override is needed
      // there. Shared keys go through hasSharedProviderKey — see its
      // doc comment for why this can't independently drift from
      // k8sClient.ts's casing again.
      const hasSharedKey = hasSharedProviderKey(sharedKeys, provider);

      if (!hasPerAgentKey && !hasSharedKey) {
        log.warn("No provider key found (per-agent or shared)", {
          agent: agent.id, pipeline: kind, provider,
        });
        continue;
      }
      const secretKey = resolveProviderSecretKey(agent.id, provider, hasPerAgentKey);
      extraEnv.push({ name: envName, secretKey });
      injected.add(envName);
      log.info("Wired provider key reference", {
        agent: agent.id, pipeline: kind, provider, envName, secretKey,
        source: hasPerAgentKey ? "per-agent" : "shared",
      });
    }
  } catch (err) {
    log.warn("Failed to resolve provider key references (non-fatal)", { error: String(err) });
  }

  // 5c. BitHuman avatar keys — shared across all agents (one GPU server).
  // These live at secret/shared/bithuman, not per-app.
  if (agent.avatarEnabled) {
    try {
      const { readPlatformVaultPath } = await import("../vaultClient.js");
      const bhData = (await readPlatformVaultPath("shared/bithuman")) || {};
      if (bhData.bithuman_api_key) {
        extraEnv.push({ name: "BITHUMAN_API_KEY", secretKey: "shared_bithuman_api_key" });
      }
      if (bhData.bithuman_api_secret) {
        extraEnv.push({ name: "BITHUMAN_API_SECRET", secretKey: "shared_bithuman_api_secret" });
      }
      // External LiveKit URL for BitHuman (BitHuman is outside K8s, can't use internal URL)
      if (bhData.bithuman_livekit_url) {
        extraEnv.push({ name: "BITHUMAN_LIVEKIT_URL", secretKey: "shared_bithuman_livekit_url" });
      }
      log.info("Injected BitHuman keys from shared Vault", { agentId: agent.id });
    } catch (err) {
      log.warn("Failed to read BitHuman keys from shared Vault (non-fatal)", { error: String(err) });
    }

    // Generate a presigned URL for the avatar image. BitHuman is external
    // (192.168.0.10), so the URL must be generated with the external MinIO endpoint.
    if (agent.avatarImageUrl) {
      try {
        const Minio = await import("minio");
        const externalHost = process.env.MINIO_EXTERNAL_ENDPOINT || "s3.baisoln.com";
        const [extHostname, extPort] = externalHost.split(":");
        // Create a MinIO client pointing to the external endpoint for presigned URL generation
        const { getClient } = await import("./minioAdmin.js");
        const internalClient = await getClient();
        const externalClient = new Minio.Client({
          endPoint: extHostname,
          port: extPort ? parseInt(extPort) : 443,
          useSSL: true,
          accessKey: (internalClient as any).accessKey || process.env.MINIO_ROOT_USER || "",
          secretKey: (internalClient as any).secretKey || process.env.MINIO_ROOT_PASSWORD || "",
        });
        const [bucket, ...keyParts] = agent.avatarImageUrl.split("/");
        const key = keyParts.join("/");
        const presignedUrl = await externalClient.presignedGetObject(bucket, key, 7 * 24 * 60 * 60);
        configData.BITHUMAN_AVATAR_IMAGE = presignedUrl;
        log.info("Generated presigned avatar URL (external)", { agentId: agent.id, bucket, key, host: externalHost });
      } catch (err) {
        log.warn("Failed to generate external presigned avatar URL (non-fatal)", { error: String(err) });
        // Fallback: use internal presigned URL (works for in-cluster access, not BitHuman)
        try {
          const { getClient } = await import("./minioAdmin.js");
          const client = await getClient();
          const [bucket, ...keyParts] = agent.avatarImageUrl.split("/");
          const key = keyParts.join("/");
          configData.BITHUMAN_AVATAR_IMAGE = await client.presignedGetObject(bucket, key, 7 * 24 * 60 * 60);
        } catch {}
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
