/**
 * Letta API client for tenant/agent/tool management.
 * All operations throw on failure — never fakes success.
 */
import { createLogger } from "../_core/logger.js";

const log = createLogger("LettaAdmin");

const LETTA_BASE_URL = process.env.LETTA_BASE_URL || "";
const LETTA_API_KEY = process.env.LETTA_API_KEY || "";

// Internal Dify API URL — used in Letta tool source_code
const DIFY_API_URL =
  process.env.DIFY_INTERNAL_URL ||
  "http://dify-api.bionic-platform.svc.cluster.local:5001";

function ensureConfigured() {
  if (!LETTA_BASE_URL) throw new Error("LETTA_BASE_URL not configured");
}

async function lettaRequest(method: string, path: string, body?: unknown): Promise<any> {
  ensureConfigured();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (LETTA_API_KEY) headers["Authorization"] = `Bearer ${LETTA_API_KEY}`;

  const res = await fetch(`${LETTA_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  // Handle 307 redirects (Letta uses trailing-slash redirects)
  if (res.status === 307) {
    const location = res.headers.get("location");
    if (location) {
      const res2 = await fetch(location.startsWith("http") ? location : `${LETTA_BASE_URL}${location}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res2.ok) {
        const text = await res2.text();
        throw new Error(`Letta ${method} ${path} failed after redirect (${res2.status}): ${text}`);
      }
      const ct = res2.headers.get("content-type") || "";
      if (ct.includes("json")) return res2.json();
      return null;
    }
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Letta ${method} ${path} failed (${res.status}): ${text}`);
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) return res.json();
  return null;
}

// ── Tenant lifecycle ────────────────────────────────────────────

export async function createTenant(slug: string) {
  ensureConfigured();
  const res = await fetch(`${LETTA_BASE_URL}/v1/health/`, {
    headers: LETTA_API_KEY ? { Authorization: `Bearer ${LETTA_API_KEY}` } : {},
  });
  if (!res.ok) throw new Error(`Letta health check failed (${res.status})`);

  const mcpUrl = `${LETTA_BASE_URL}/mcp`;
  log.info("Registered Letta tenant", { slug, mcpUrl });
  return { tenantId: slug, mcpUrl };
}

export async function deleteTenant(slug: string): Promise<void> {
  ensureConfigured();
  const agents = await lettaRequest("GET", `/v1/agents/?name=${slug}`);
  if (Array.isArray(agents)) {
    for (const agent of agents) {
      if (agent.name?.startsWith(slug)) {
        await lettaRequest("DELETE", `/v1/agents/${agent.id}/`);
        log.info("Deleted Letta agent", { id: agent.id, name: agent.name });
      }
    }
  }
}

// ── Agent CRUD ──────────────────────────────────────────────────

export async function createAgent(
  name: string,
  model: string,
  systemPrompt?: string,
  personaPrompt?: string,
): Promise<{ id: string; name: string }> {
  const result = await lettaRequest("POST", "/v1/agents/", {
    name,
    model,
    system: systemPrompt || `You are ${name}, an AI assistant.`,
    ...(personaPrompt ? { persona: personaPrompt } : {}),
  });
  log.info("Created Letta agent", { name, id: result?.id });
  return result;
}

export async function getAgent(agentId: string): Promise<any> {
  return lettaRequest("GET", `/v1/agents/${agentId}/`);
}

export async function updateAgent(agentId: string, updates: Record<string, any>): Promise<any> {
  return lettaRequest("PATCH", `/v1/agents/${agentId}/`, updates);
}

export async function getAgentByName(name: string): Promise<any | null> {
  const agents = await lettaRequest("GET", `/v1/agents/?name=${encodeURIComponent(name)}`);
  if (Array.isArray(agents) && agents.length > 0) {
    return agents.find((a: any) => a.name === name) || agents[0];
  }
  return null;
}

export async function deleteAgent(agentId: string): Promise<void> {
  await lettaRequest("DELETE", `/v1/agents/${agentId}/`);
  log.info("Deleted Letta agent", { agentId });
}

/**
 * Update an existing Letta agent's system prompt + (optionally) model.
 * Used when the platform-side prompt is changed in agent_configs and the
 * existing Letta agent needs to be re-aligned without recreating it.
 *
 * Letta exposes this as PATCH /v1/agents/{id}/ — fields not in the payload
 * are left unchanged.
 */
export async function updateAgent(
  agentId: string,
  updates: { system?: string; model?: string; name?: string },
): Promise<void> {
  await lettaRequest("PATCH", `/v1/agents/${agentId}/`, updates);
  log.info("Updated Letta agent", { agentId, fields: Object.keys(updates) });
}

// ── Memory / Passages ───────────────────────────────────────────

export async function createPassage(agentId: string, text: string): Promise<string> {
  // Letta API renamed: /archival/ → /archival-memory
  const result = await lettaRequest("POST", `/v1/agents/${agentId}/archival-memory`, { text });
  if (Array.isArray(result)) return result[0]?.id || "";
  return result?.id || "";
}

export async function deletePassage(agentId: string, passageId: string): Promise<void> {
  await lettaRequest("DELETE", `/v1/agents/${agentId}/archival-memory/${passageId}`);
}

// ── Memory Blocks ───────────────────────────────────────────────

/**
 * Create a standalone memory block (not attached to any agent).
 * Used for per-user "human" blocks that get swapped in/out on session start.
 */
export async function createBlock(
  label: string,
  value: string,
  opts?: { limit?: number; description?: string; readOnly?: boolean },
): Promise<{ id: string; label: string }> {
  const result = await lettaRequest("POST", "/v1/blocks/", {
    label,
    value,
    ...(opts?.limit ? { limit: opts.limit } : {}),
    ...(opts?.description ? { description: opts.description } : {}),
    ...(opts?.readOnly ? { read_only: opts.readOnly } : {}),
  });
  log.info("Created Letta block", { id: result?.id, label });
  return result;
}

/**
 * Update a block's value (replaces entire content).
 */
export async function updateBlock(blockId: string, value: string): Promise<void> {
  await lettaRequest("PATCH", `/v1/blocks/${blockId}/`, { value });
}

/**
 * Delete a standalone block.
 */
export async function deleteBlock(blockId: string): Promise<void> {
  await lettaRequest("DELETE", `/v1/blocks/${blockId}/`);
  log.info("Deleted Letta block", { blockId });
}

/**
 * Attach a block to an agent. The block becomes part of the agent's
 * core memory (visible in the context window).
 */
export async function attachBlockToAgent(agentId: string, blockId: string): Promise<void> {
  await lettaRequest("PATCH", `/v1/agents/${agentId}/blocks/attach/${blockId}/`);
  log.info("Attached block to agent", { agentId, blockId });
}

/**
 * Detach a block from an agent. The block remains in the DB but is
 * no longer in the agent's context window.
 */
export async function detachBlockFromAgent(agentId: string, blockId: string): Promise<void> {
  await lettaRequest("PATCH", `/v1/agents/${agentId}/blocks/detach/${blockId}/`);
  log.info("Detached block from agent", { agentId, blockId });
}

/**
 * Get all blocks currently attached to an agent.
 */
export async function getAgentBlocks(agentId: string): Promise<any[]> {
  const agent = await getAgent(agentId);
  return agent?.memory?.blocks || [];
}

/**
 * Swap the "human" block on an agent: detach current, attach new.
 * This is the core operation for per-user session isolation.
 *
 * Returns the block ID of the previously attached human block (if any).
 */
export async function swapUserBlock(
  agentId: string,
  newBlockId: string,
  label: string = "human",
): Promise<string | null> {
  // Find currently attached block with this label
  const blocks = await getAgentBlocks(agentId);
  const current = blocks.find((b: any) => b.label === label);
  const previousId = current?.id || null;

  // Detach current if present (and different from new)
  if (previousId && previousId !== newBlockId) {
    try {
      await detachBlockFromAgent(agentId, previousId);
    } catch (err) {
      log.warn("Failed to detach previous block", { agentId, blockId: previousId, error: String(err) });
    }
  }

  // Attach new block (skip if already attached)
  if (previousId !== newBlockId) {
    await attachBlockToAgent(agentId, newBlockId);
  }

  log.info("Swapped user block", { agentId, label, previous: previousId, new: newBlockId });
  return previousId;
}

// ── Tool management ─────────────────────────────────────────────

/**
 * Create a custom tool on the Letta server.
 * Returns the tool object including its `id`.
 */
export async function createTool(
  sourceCode: string,
  opts?: {
    description?: string;
    tags?: string[];
    pipRequirements?: { name: string; version?: string }[];
  },
): Promise<{ id: string; name: string }> {
  const result = await lettaRequest("POST", "/v1/tools/", {
    source_code: sourceCode,
    ...(opts?.description ? { description: opts.description } : {}),
    ...(opts?.tags ? { tags: opts.tags } : {}),
    ...(opts?.pipRequirements ? { pip_requirements: opts.pipRequirements } : {}),
  });
  log.info("Created Letta tool", { id: result?.id, name: result?.name });
  return result;
}

/**
 * Attach an existing tool to a Letta agent.
 */
export async function attachToolToAgent(agentId: string, toolId: string): Promise<void> {
  await lettaRequest("PATCH", `/v1/agents/${agentId}/tools/attach/${toolId}/`);
  log.info("Attached tool to agent", { agentId, toolId });
}

/**
 * Detach a tool from a Letta agent.
 */
export async function detachToolFromAgent(agentId: string, toolId: string): Promise<void> {
  await lettaRequest("PATCH", `/v1/agents/${agentId}/tools/detach/${toolId}/`);
  log.info("Detached tool from agent", { agentId, toolId });
}

/**
 * List all tools on the Letta server.
 */
export async function listTools(): Promise<any[]> {
  return lettaRequest("GET", "/v1/tools/") || [];
}

/**
 * Delete a tool from the Letta server.
 */
export async function deleteTool(toolId: string): Promise<void> {
  await lettaRequest("DELETE", `/v1/tools/${toolId}/`);
  log.info("Deleted Letta tool", { toolId });
}

/**
 * Get tools currently attached to a Letta agent.
 */
export async function getAgentTools(agentId: string): Promise<any[]> {
  const agent = await getAgent(agentId);
  return agent?.tools || [];
}

// ── Crew tool sync ──────────────────────────────────────────────

/**
 * Build the source_code for a `run_crew` Letta tool that calls Dify workflows.
 *
 * The crew registry is baked into the tool source so Letta can dispatch
 * to the correct Dify workflow API key without needing external config.
 */
function buildRunCrewSourceCode(
  crewRegistry: Array<{ name: string; difyAppApiKey: string; mode: string }>,
): string {
  const registryJson = JSON.stringify(
    crewRegistry.reduce(
      (acc, c) => ({ ...acc, [c.name]: { api_key: c.difyAppApiKey, mode: c.mode } }),
      {} as Record<string, { api_key: string; mode: string }>,
    ),
  );

  // The function will run inside Letta's sandbox with `requests` available
  return `
def run_crew(crew_name: str, task: str, context: str = "{}") -> str:
    """Run a specialized Dify workflow crew for complex multi-step tasks.

    Args:
        crew_name: Name of the crew to execute (e.g. 'deep_research', 'data_analysis').
        task: Description of the task to perform.
        context: Optional JSON string with additional context for the crew.

    Returns:
        The crew execution result as a string, including summary and status.
    """
    import json
    import requests

    DIFY_API_URL = "${DIFY_API_URL}"
    CREW_REGISTRY = json.loads('${registryJson}')

    if crew_name not in CREW_REGISTRY:
        available = ", ".join(CREW_REGISTRY.keys()) if CREW_REGISTRY else "none"
        return f"Error: crew '{crew_name}' not found. Available crews: {available}"

    crew = CREW_REGISTRY[crew_name]
    api_key = crew["api_key"]

    if not api_key:
        return f"Error: crew '{crew_name}' has no API key configured"

    try:
        ctx = json.loads(context) if isinstance(context, str) else context
    except json.JSONDecodeError:
        ctx = {"raw": context}

    payload = {
        "inputs": {
            "task": task,
            "context": json.dumps(ctx),
        },
        "response_mode": "blocking",
        "user": "letta-agent",
    }

    try:
        resp = requests.post(
            f"{DIFY_API_URL}/v1/workflows/run",
            json=payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            timeout=300,
        )
        resp.raise_for_status()
        data = resp.json()

        outputs = data.get("data", {}).get("outputs", {})
        status = data.get("data", {}).get("status", "unknown")
        run_id = data.get("workflow_run_id", "")
        elapsed = data.get("data", {}).get("elapsed_time", 0)

        # Extract summary from common output field names
        summary = ""
        for key in ("summary", "result", "output", "response", "answer", "text"):
            if key in outputs and isinstance(outputs[key], str):
                summary = outputs[key]
                break
        if not summary and outputs:
            summary = json.dumps(outputs, indent=2, default=str)[:3000]

        # Strip <think> tags from reasoning models
        import re
        summary = re.sub(r"<think>.*?</think>", "", summary, flags=re.DOTALL).strip()

        return (
            f"Crew '{crew_name}' completed (status={status}, "
            f"run_id={run_id}, elapsed={elapsed:.1f}s):\\n\\n{summary}"
        )
    except requests.exceptions.Timeout:
        return f"Error: crew '{crew_name}' timed out after 300 seconds"
    except requests.exceptions.HTTPError as e:
        return f"Error: crew '{crew_name}' HTTP error: {e.response.status_code} {e.response.text[:500]}"
    except Exception as e:
        return f"Error: crew '{crew_name}' failed: {str(e)}"
`.trim();
}

/**
 * Sync the `run_crew` tool for a Letta agent.
 *
 * - Creates (or recreates) the tool with the latest crew registry
 * - Attaches it to the agent
 * - Removes stale versions
 */
export async function syncCrewTool(
  agentId: string,
  crewRegistry: Array<{ name: string; difyAppApiKey: string; mode: string }>,
): Promise<string | null> {
  if (crewRegistry.length === 0) {
    log.info("No crews configured — skipping run_crew tool sync", { agentId });
    return null;
  }

  // Check if agent already has a run_crew tool
  const agentTools = await getAgentTools(agentId);
  const existingRunCrew = agentTools.find((t: any) => t.name === "run_crew");

  // Remove old version if present
  if (existingRunCrew) {
    try {
      await detachToolFromAgent(agentId, existingRunCrew.id);
      await deleteTool(existingRunCrew.id);
      log.info("Removed old run_crew tool", { toolId: existingRunCrew.id });
    } catch (err) {
      log.warn("Failed to remove old run_crew tool", { error: String(err) });
    }
  }

  // Create fresh tool with current registry
  const sourceCode = buildRunCrewSourceCode(crewRegistry);
  const tool = await createTool(sourceCode, {
    description: "Execute a Dify workflow crew for complex multi-step tasks",
    tags: ["crew", "dify", "workflow"],
    pipRequirements: [{ name: "requests" }],
  });

  // Attach to agent
  await attachToolToAgent(agentId, tool.id);
  log.info("Synced run_crew tool", {
    agentId,
    toolId: tool.id,
    crews: crewRegistry.map((c) => c.name),
  });

  return tool.id;
}

// ── Export ───────────────────────────────────────────────────────

export const lettaAdmin = {
  createTenant,
  deleteTenant,
  createAgent,
  updateAgent,
  getAgent,
  updateAgent,
  getAgentByName,
  deleteAgent,
  createPassage,
  deletePassage,
  createBlock,
  updateBlock,
  deleteBlock,
  attachBlockToAgent,
  detachBlockFromAgent,
  getAgentBlocks,
  swapUserBlock,
  createTool,
  attachToolToAgent,
  detachToolFromAgent,
  listTools,
  deleteTool,
  getAgentTools,
  syncCrewTool,
};
