// ── STT Providers ───────────────────────────────────────────────

export interface ProviderOption {
  value: string;
  label: string;
  description: string;
  requiresKey?: boolean;
  keyEnvName?: string;
}

export interface ModelOption {
  value: string;
  label: string;
}

/**
 * Whether a provider needs an API key (and therefore the "Test & Save key" UI).
 * Keyless providers (gpu-ai, custom, letta, faster-whisper) route through
 * in-cluster services and have no key to validate — showing the key input for
 * them lets a user trigger setProviderKey, which throws PRECONDITION_FAILED.
 * Gate the key UI on this instead of hardcoded provider lists.
 */
export function providerRequiresKey(providers: ProviderOption[], value: string): boolean {
  return providers.find((p) => p.value === value)?.requiresKey === true;
}

export const STT_PROVIDERS: ProviderOption[] = [
  { value: "gpu-ai", label: "GPU-AI (Faster Whisper via MCP)", description: "In-cluster GPU, low latency" },
  { value: "faster-whisper", label: "Faster Whisper (Direct)", description: "Direct in-cluster, lowest latency" },
  { value: "deepgram", label: "Deepgram (Cloud)", description: "Cloud API, high accuracy", requiresKey: true, keyEnvName: "DEEPGRAM_API_KEY" },
];


// ── LLM Providers ───────────────────────────────────────────────

export const LLM_PROVIDERS: ProviderOption[] = [
  { value: "letta", label: "Letta (Recommended)", description: "LLM via Letta agent — includes memory, tools, and context" },
  { value: "openai", label: "OpenAI", description: "GPT-4o, GPT-4.1", requiresKey: true, keyEnvName: "OPENAI_API_KEY" },
  { value: "openrouter", label: "OpenRouter", description: "Multi-model router", requiresKey: true, keyEnvName: "OPENROUTER_API_KEY" },
  { value: "gpu-ai", label: "GPU-AI (Local)", description: "In-cluster GPU inference" },
  { value: "custom", label: "Custom (OpenAI-compatible)", description: "Self-hosted endpoint", requiresKey: true, keyEnvName: "CUSTOM_LLM_API_KEY" },
  { value: "gemini", label: "Gemini", description: "Google Gemini 2.5 Flash — fast, smart, economical", requiresKey: true, keyEnvName: "GEMINI_API_KEY" },
];


// ── TTS Providers ───────────────────────────────────────────────

export const TTS_PROVIDERS: ProviderOption[] = [
  { value: "gpu-ai", label: "GPU-AI (IndexTTS-2 / Indic Parler)", description: "In-cluster GPU — cloned & named voices" },
  { value: "async", label: "Async (Cloud)", description: "Streaming-first, ultra-low latency TTS", requiresKey: true, keyEnvName: "ASYNC_API_KEY" },
  { value: "elevenlabs", label: "ElevenLabs (Cloud)", description: "Cloud API, premium voices", requiresKey: true, keyEnvName: "ELEVENLABS_API_KEY" },
  { value: "cartesia", label: "Cartesia (Cloud)", description: "Cloud API, fast low-latency TTS", requiresKey: true, keyEnvName: "CARTESIA_API_KEY" },
  { value: "sarvam", label: "Sarvam AI", description: "Indic-focused voices, 7 presets", requiresKey: true, keyEnvName: "SARVAM_API_KEY" },
];


// Sarvam's supported target_language_code values for TTS synthesis. Only
// consumed by the sarvam provider — its API requires an explicit code (no
// auto-detect). en-IN is first/default to preserve existing agent behavior.
// ── Voice / model catalogues live on the SERVER ─────────────────
//
// STT_MODELS, LLM_MODELS and TTS_VOICES used to live here. They were a second,
// hand-maintained answer to a question the server already answers, and the two
// drifted: this file's gpu-ai list held 7 voices while the gateway served 191,
// and a guard in LiveKitSection reset any choice outside those 7 — so 184
// voices, every cloned one included, could be offered and never kept. The same
// list still named Indic-Parler voices the endpoint had already dropped.
//
// The server now returns the list AND its provenance from
// agentsCrud.listProviderVoices / listProviderModels: live where the provider
// exposes discovery, a fallback (server/services/voiceProviders.ts) where it
// does not. The client renders what it is told and validates nothing — the
// save path already validates against the live list.
//
// The provider lists here stay: they are UI copy, not a catalogue.

export const TTS_LANGUAGES: ModelOption[] = [
  { value: "en-IN", label: "English (India)" },
  { value: "bn-IN", label: "Bengali" },
  { value: "gu-IN", label: "Gujarati" },
  { value: "hi-IN", label: "Hindi" },
  { value: "kn-IN", label: "Kannada" },
  { value: "ml-IN", label: "Malayalam" },
  { value: "mr-IN", label: "Marathi" },
  { value: "od-IN", label: "Odia" },
  { value: "pa-IN", label: "Punjabi" },
  { value: "ta-IN", label: "Tamil" },
  { value: "te-IN", label: "Telugu" },
];

// ── Letta LLM Models (for secondary agent) ──────────────────────

// Letta (secondary executor) defaults to the thinking variant — this
// brain does the heavy reasoning, so CoT pays off. The no-think variant
// is here for agents that don't need derivation (faster).
export const LETTA_LLM_MODELS: ModelOption[] = [
  { value: "qwen3.6-35b-a3b-fp8-think", label: "Qwen 3.6 35B (Thinking — GPU, default)" },
  { value: "qwen3.6-35b-a3b-fp8", label: "Qwen 3.6 35B (Fast, no-think — GPU)" },
  { value: "anthropic/claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
  { value: "openai/gpt-4o", label: "GPT-4o" },
  { value: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
];

// ── Crew Definitions ────────────────────────────────────────────

export interface CrewDefinition {
  id?: number;
  name: string;
  label: string;
  description: string;
  difyAppId?: string;
  mode?: string;
  isTemplate?: boolean;
}

/**
 * @deprecated Use dynamic crew registry from DB instead. Crew templates are
 * now loaded from server/crewTemplates/*.yaml via crewTemplateLoader.
 * Kept as an empty array for backward compatibility with listAvailableCrews.
 */
export const AVAILABLE_CREWS: CrewDefinition[] = [];
