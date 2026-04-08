/**
 * LLM provider model-list discovery + key validation.
 *
 * Used by setProviderKey to validate a key at save time and by
 * listProviderModels to populate the Agent Builder model dropdown
 * with whatever the provider actually exposes for that key.
 *
 * Each provider's /v1/models endpoint is OpenAI-compatible — the
 * response shape is `{ data: [{ id: string, ... }, ...] }`. We hit
 * it with a Bearer token and surface the model ids.
 *
 * Throws TRPCError on auth failure / unreachable provider so the
 * caller can show a real error to the user instead of silently
 * persisting a bad key.
 */
import { TRPCError } from "@trpc/server";
import { createLogger } from "../_core/logger.js";

const log = createLogger("LLMProviders");

export interface ProviderModel {
  id: string;
  name?: string;
  description?: string;
  /** Optional capabilities surfaced by some providers (openrouter). */
  contextLength?: number;
  pricing?: { prompt?: string; completion?: string };
}

interface ProviderConfig {
  /** Lowercase llmProvider value used in agentConfigs / Vault. */
  key: string;
  /** Human-readable label for logs / UI. */
  label: string;
  /** OpenAI-compatible /v1/models URL. */
  modelsUrl: string;
  /** Filter for the model list — keep only chat-capable IDs. */
  filter?: (id: string) => boolean;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  openai: {
    key: "openai",
    label: "OpenAI",
    modelsUrl: "https://api.openai.com/v1/models",
    // Drop embeddings, dall-e, tts, whisper, fine-tunes — only chat models.
    filter: (id) =>
      /^(gpt-|o1|o3|chatgpt-)/i.test(id) &&
      !/embedding|whisper|tts|dall-e|moderation|babbage|davinci/i.test(id),
  },
  openrouter: {
    key: "openrouter",
    label: "OpenRouter",
    modelsUrl: "https://openrouter.ai/api/v1/models",
    // OpenRouter exposes hundreds — let everything through; UI can search.
  },
};

export function isSupportedProvider(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, provider.toLowerCase());
}

/**
 * Fetch and parse the model list for a provider using the supplied API key.
 * Returns a sorted, de-duplicated list of `ProviderModel` objects.
 *
 * Errors:
 *  - PRECONDITION_FAILED if the provider is unknown.
 *  - UNAUTHORIZED if the provider returns 401/403.
 *  - BAD_GATEWAY for other HTTP / network failures.
 */
export async function listModelsForProvider(
  provider: string,
  apiKey: string,
): Promise<ProviderModel[]> {
  const cfg = PROVIDERS[provider.toLowerCase()];
  if (!cfg) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `LLM provider '${provider}' is not supported for live model discovery (supported: ${Object.keys(PROVIDERS).join(", ")})`,
    });
  }

  let res: Response;
  try {
    res = await fetch(cfg.modelsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter wants these for tracking — harmless on OpenAI.
        "HTTP-Referer": "https://platform.baisoln.com",
        "X-Title": "bionic-platform",
      },
    });
  } catch (err) {
    log.error("Provider /v1/models fetch failed", { provider, error: String(err) });
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `Failed to reach ${cfg.label}: ${String(err).slice(0, 120)}`,
    });
  }

  if (res.status === 401 || res.status === 403) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 200);
    } catch {}
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: `${cfg.label} rejected the API key (HTTP ${res.status}): ${body}`,
    });
  }

  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 200);
    } catch {}
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `${cfg.label} /v1/models returned HTTP ${res.status}: ${body}`,
    });
  }

  let parsed: any;
  try {
    parsed = await res.json();
  } catch (err) {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `${cfg.label} returned non-JSON model list`,
    });
  }

  const raw: any[] = Array.isArray(parsed?.data) ? parsed.data : [];
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const id = typeof m.id === "string" ? m.id : null;
    if (!id) continue;
    if (cfg.filter && !cfg.filter(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: typeof m.name === "string" ? m.name : undefined,
      description: typeof m.description === "string" ? m.description : undefined,
      contextLength: typeof m.context_length === "number" ? m.context_length : undefined,
      pricing: m.pricing && typeof m.pricing === "object"
        ? {
            prompt: typeof m.pricing.prompt === "string" ? m.pricing.prompt : undefined,
            completion: typeof m.pricing.completion === "string" ? m.pricing.completion : undefined,
          }
        : undefined,
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  log.info("Discovered models", { provider, count: models.length });
  return models;
}

/** All providers with live model discovery support. */
export function listSupportedProviders(): ProviderConfig[] {
  return Object.values(PROVIDERS);
}
