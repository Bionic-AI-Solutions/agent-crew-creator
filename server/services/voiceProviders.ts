/**
 * STT/TTS provider voice + model discovery + key validation.
 *
 * Mirrors llmProviders.ts but for the audio pipelines. Each provider
 * exposes a /voices or /models endpoint that we hit with a Bearer token
 * to (a) validate the key and (b) populate the Agent Builder dropdown.
 *
 * Returns rich objects so the UI can show name + language + preview URL
 * where the provider supplies them.
 */
import { TRPCError } from "@trpc/server";
import { createLogger } from "../_core/logger.js";

const log = createLogger("VoiceProviders");

export interface VoiceOption {
  /** The id passed back as `tts_voice` / `stt_model`. */
  id: string;
  /** Human-readable name. */
  name?: string;
  /** Language tag (e.g., "en-US"). */
  language?: string;
  /** Optional gender / persona tag. */
  description?: string;
  /** Sample / preview URL where provider supplies one. */
  previewUrl?: string;
}

interface VoiceProviderConfig {
  key: string;
  label: string;
  /** Pipeline this provider belongs to. */
  pipeline: "tts" | "stt";
  /** Authentication header. Most are Bearer; cartesia is X-API-Key. */
  authHeader: (apiKey: string) => Record<string, string>;
  /** URL returning the list, or a thunk for providers whose base is env-derived. */
  listUrl: string | (() => string);
  /**
   * False for in-cluster providers reached without credentials. Defaults to
   * true: every external provider's list endpoint doubles as its key probe.
   */
  requiresKey?: boolean;
  /** HTTP method — defaults to GET. Async uses POST. */
  method?: "GET" | "POST";
  /**
   * Request body for POST providers. Defaults to `{}` when omitted
   * (matches the pre-existing behavior for `async`). Providers with no
   * free validation endpoint (e.g. sarvam, whose only auth probe is a
   * real synthesis call) set this to a real request body — the call
   * still incurs the provider's normal usage cost, same as their own
   * health_check() would.
   */
  body?: unknown;
  /** Parse the raw API response into VoiceOption[]. */
  parse: (raw: any) => VoiceOption[];
}

/**
 * Base URL of the in-cluster mcp-api-server that serves gpu-ai voices.
 *
 * Exported so the Agent Builder dropdown and the save-time voice validation
 * in agentRouter resolve the SAME endpoint. They used to derive it
 * separately, which is how the dropdown came to offer 7 voices while the
 * validator accepted 190.
 */
export function gpuAiBase(): string {
  return (
    process.env.GPU_AI_LLM_INTERNAL_URL ||
    "http://mcp-api-server.mcp.svc.cluster.local:8000"
  )
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
}

const PROVIDERS: Record<string, VoiceProviderConfig> = {
  "gpu-ai": {
    key: "gpu-ai",
    label: "GPU-AI",
    pipeline: "tts",
    // In-cluster and unauthenticated -- there is no key to send or validate.
    requiresKey: false,
    authHeader: () => ({}),
    listUrl: () => `${gpuAiBase()}/v1/audio/voices`,
    // This is where the cloned voices live. Without this entry the provider
    // fell through to `supported: false` and the builder showed the seven
    // hardcoded names in TTS_VOICES["gpu-ai"], while the endpoint served 190
    // -- so no cloned voice was selectable, even though save-time validation
    // already accepted every one of them.
    parse: (raw) => {
      const arr: any[] = raw?.data?.voices ?? raw?.voices ?? [];
      return arr.flatMap((v): VoiceOption[] => {
        // The endpoint keys voices by name; id is absent on some entries.
        const id = v?.id || v?.name;
        if (typeof id !== "string" || !id) return [];
        // 30 display names repeat across engines (two "Adam", two "Sarah",
        // a "Aditya" from sarvam and an "aditya" from omnivoice), so the
        // engine has to appear in the label or the list is unusable. It also
        // makes the picker's search box filter by engine and by "cloned",
        // since it searches id + name + description.
        const bits = [
          v.engine_display || v.engine || undefined,
          // Two engines mark clones differently: elevenlabs sets
          // meta.category, omnivoice instead carries a registry_voice_id
          // (37 of them). Neither appears on kokoro/openai/sarvam, so this
          // labels exactly the 42 cloned voices and nothing else.
          v.meta?.category === "cloned" || v.meta?.registry_voice_id
            ? "cloned"
            : undefined,
          v.gender || undefined,
        ].filter(Boolean);
        return [{
          id,
          name: v.name || undefined,
          language: v.language || v.lang || undefined,
          description: bits.length ? bits.join(" • ") : undefined,
        }];
      });
    },
  },
  cartesia: {
    key: "cartesia",
    label: "Cartesia",
    pipeline: "tts",
    authHeader: (key) => ({
      "X-API-Key": key,
      // Cartesia requires this version header on all calls.
      "Cartesia-Version": "2024-06-10",
    }),
    listUrl: "https://api.cartesia.ai/voices",
    parse: (raw) => {
      // Cartesia returns either a top-level array OR { data: [...] }.
      const arr: any[] = Array.isArray(raw) ? raw : (raw?.data ?? []);
      return arr
        .filter((v) => v && typeof v.id === "string")
        .map((v) => ({
          id: v.id,
          name: v.name || undefined,
          language: v.language || undefined,
          description: v.description || undefined,
          previewUrl: v.preview_url || undefined,
        }));
    },
  },
  elevenlabs: {
    key: "elevenlabs",
    label: "ElevenLabs",
    pipeline: "tts",
    authHeader: (key) => ({ "xi-api-key": key }),
    listUrl: "https://api.elevenlabs.io/v1/voices",
    parse: (raw) => {
      const arr: any[] = raw?.voices ?? [];
      return arr
        .filter((v) => v && typeof v.voice_id === "string")
        .map((v) => ({
          id: v.voice_id,
          name: v.name || undefined,
          description: v.category || undefined,
          previewUrl: v.preview_url || undefined,
          language: v.labels?.language || undefined,
        }));
    },
  },
  openai: {
    key: "openai",
    label: "OpenAI",
    pipeline: "tts",
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
    // OpenAI doesn't expose a voice list endpoint; the voices are
    // fixed and documented. We hardcode the known set here, gated by
    // a successful auth round-trip to /v1/models.
    listUrl: "https://api.openai.com/v1/models",
    parse: (_raw) => [
      { id: "alloy", name: "Alloy", description: "neutral" },
      { id: "echo", name: "Echo", description: "male" },
      { id: "fable", name: "Fable", description: "British male" },
      { id: "onyx", name: "Onyx", description: "deep male" },
      { id: "nova", name: "Nova", description: "female" },
      { id: "shimmer", name: "Shimmer", description: "soft female" },
    ],
  },
  async: {
    key: "async",
    label: "Async",
    pipeline: "tts",
    authHeader: (key) => ({ "X-Api-Key": key, "Content-Type": "application/json" }),
    listUrl: "https://api.async.com/voices",
    method: "POST",
    parse: (raw: any) => {
      const voices = raw?.voices || (Array.isArray(raw) ? raw : []);
      return voices.map((v: any) => ({
        id: v.voice_id || v.id || "",
        name: v.name || "Unknown",
        description: `${v.accent || ""} ${v.gender || ""} — ${(v.style || "").slice(0, 50)}`.trim(),
        language: v.language || "",
      }));
    },
  },
  sarvam: {
    key: "sarvam",
    label: "Sarvam AI",
    pipeline: "tts",
    authHeader: (key) => ({ "api-subscription-key": key, "Content-Type": "application/json" }),
    // No free liveness/list endpoint exists — a real (billed) synthesis
    // call is the only way to validate a key. Response content is
    // ignored; only a non-401/403 status confirms the key works.
    // Payload field names match the installed livekit-plugins-sarvam's
    // own REST request shape exactly (tts.py's _run() payload dict) —
    // an earlier version of this body used "inputs": [...] (the legacy
    // mcp-api-server reference implementation's field name), which the
    // real API likely 400s on since the actual field is "text": <str>.
    // Confirmed against the installed package 2026-07-15.
    listUrl: "https://api.sarvam.ai/text-to-speech",
    method: "POST",
    body: { target_language_code: "en-IN", text: "ok", speaker: "anushka", model: "bulbul:v2" },
    // Static preset set (no live discovery) — same shape as openai's
    // hardcoded voice list below. Must match TTS_VOICES.sarvam in
    // shared/providerOptions.ts exactly — 7 voices, not the 9 the
    // mcp-api-server reference implementation lists; diya/maitreyi
    // aren't in bulbul:v2's compatibility table for this package
    // version (confirmed live 2026-07-15, see providerOptions.ts).
    parse: (_raw) => [
      { id: "anushka", name: "Anushka", description: "female" },
      { id: "abhilash", name: "Abhilash", description: "male" },
      { id: "manisha", name: "Manisha", description: "female" },
      { id: "vidya", name: "Vidya", description: "female" },
      { id: "arya", name: "Arya", description: "female" },
      { id: "karun", name: "Karun", description: "male" },
      { id: "hitesh", name: "Hitesh", description: "male" },
    ],
  },
  // ── STT side ────────────────────────────────────────────────
  deepgram: {
    key: "deepgram",
    label: "Deepgram",
    pipeline: "stt",
    authHeader: (key) => ({ Authorization: `Token ${key}` }),
    // Deepgram doesn't have a public /models GET — we use a
    // throwaway projects call to validate the key, then return the
    // documented set of nova / enhanced / base models.
    listUrl: "https://api.deepgram.com/v1/projects",
    parse: (_raw) => [
      { id: "nova-3", name: "Nova-3", description: "best (multilingual)" },
      { id: "nova-2", name: "Nova-2", description: "general" },
      { id: "nova-2-medical", name: "Nova-2 Medical", description: "medical" },
      { id: "nova-2-finance", name: "Nova-2 Finance", description: "finance" },
      { id: "enhanced", name: "Enhanced", description: "legacy enhanced" },
      { id: "base", name: "Base", description: "legacy base" },
    ],
  },
};

/**
 * Whether this provider's voice list needs an API key. False for in-cluster
 * providers, whose list can be fetched for any agent with no key configured.
 */
export function voiceProviderNeedsKey(provider: string): boolean {
  const cfg = PROVIDERS[provider.toLowerCase()];
  return cfg ? cfg.requiresKey !== false : true;
}

export function isSupportedVoiceProvider(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, provider.toLowerCase());
}

/**
 * Validate the API key against the provider and return the available
 * voices/models. Errors:
 *  - PRECONDITION_FAILED if provider unknown
 *  - UNAUTHORIZED on 401/403
 *  - BAD_GATEWAY for any other failure
 */
export async function listVoicesForProvider(
  provider: string,
  apiKey: string,
): Promise<VoiceOption[]> {
  const cfg = PROVIDERS[provider.toLowerCase()];
  if (!cfg) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Voice/STT provider '${provider}' is not supported (supported: ${Object.keys(PROVIDERS).join(", ")})`,
    });
  }

  let res: Response;
  try {
    const fetchOpts: RequestInit = {
      method: cfg.method || "GET",
      headers: cfg.authHeader(apiKey),
      // An in-cluster endpoint that hangs must not hang the builder dropdown.
      signal: AbortSignal.timeout(8000),
    };
    if (cfg.method === "POST") {
      fetchOpts.body = JSON.stringify(cfg.body ?? {});
    }
    const url = typeof cfg.listUrl === "function" ? cfg.listUrl() : cfg.listUrl;
    res = await fetch(url, fetchOpts);
  } catch (err) {
    log.error("Provider list fetch failed", { provider, error: String(err) });
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
      message: `${cfg.label} returned HTTP ${res.status}: ${body}`,
    });
  }

  let parsed: any;
  try {
    parsed = await res.json();
  } catch {
    throw new TRPCError({
      code: "BAD_GATEWAY",
      message: `${cfg.label} returned non-JSON response`,
    });
  }

  const voices = cfg.parse(parsed);
  voices.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  log.info("Discovered voices/models", { provider, count: voices.length });
  return voices;
}

export function listSupportedVoiceProviders(): Array<{
  key: string;
  label: string;
  pipeline: "tts" | "stt";
}> {
  return Object.values(PROVIDERS).map((p) => ({
    key: p.key,
    label: p.label,
    pipeline: p.pipeline,
  }));
}
