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
  /** URL returning the list. */
  listUrl: string;
  /** HTTP method — defaults to GET. Async uses POST. */
  method?: "GET" | "POST";
  /** Parse the raw API response into VoiceOption[]. */
  parse: (raw: any) => VoiceOption[];
}

const PROVIDERS: Record<string, VoiceProviderConfig> = {
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
    };
    if (cfg.method === "POST") {
      fetchOpts.body = JSON.stringify({});
    }
    res = await fetch(cfg.listUrl, fetchOpts);
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
