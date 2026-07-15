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

export const STT_MODELS: Record<string, ModelOption[]> = {
  // gpu-ai STT aliases the mcp-api-server /v1/audio/transcriptions endpoint
  // actually accepts. (faster-whisper-large-v3 is NOT valid — it 400s.)
  "gpu-ai": [
    { value: "whisper-large-v3", label: "Whisper Large v3 (best quality)" },
    { value: "whisper-large-v3-turbo", label: "Whisper Large v3 Turbo (faster)" },
    { value: "whisper-large-v3-turbo-ct2", label: "Whisper Large v3 Turbo CT2 (fastest)" },
    { value: "faster-whisper", label: "Faster Whisper (default)" },
    { value: "sensevoice", label: "SenseVoice (multilingual)" },
  ],
  "faster-whisper": [
    { value: "whisper-large-v3-turbo-ct2", label: "Large v3 Turbo (CTranslate2)" },
    { value: "whisper-large-v3", label: "Large v3" },
  ],
  "deepgram": [
    { value: "nova-2", label: "Nova-2" },
    { value: "nova-2-general", label: "Nova-2 General" },
    { value: "nova-2-meeting", label: "Nova-2 Meeting" },
    { value: "nova-2-phonecall", label: "Nova-2 Phone Call" },
  ],
};

// ── LLM Providers ───────────────────────────────────────────────

export const LLM_PROVIDERS: ProviderOption[] = [
  { value: "letta", label: "Letta (Recommended)", description: "LLM via Letta agent — includes memory, tools, and context" },
  { value: "openai", label: "OpenAI", description: "GPT-4o, GPT-4.1", requiresKey: true, keyEnvName: "OPENAI_API_KEY" },
  { value: "openrouter", label: "OpenRouter", description: "Multi-model router", requiresKey: true, keyEnvName: "OPENROUTER_API_KEY" },
  { value: "gpu-ai", label: "GPU-AI (Local)", description: "In-cluster GPU inference" },
  { value: "custom", label: "Custom (OpenAI-compatible)", description: "Self-hosted endpoint", requiresKey: true, keyEnvName: "CUSTOM_LLM_API_KEY" },
  { value: "gemini", label: "Gemini", description: "Google Gemini 2.5 Flash — fast, smart, economical", requiresKey: true, keyEnvName: "GEMINI_API_KEY" },
];

export const LLM_MODELS: Record<string, ModelOption[]> = {
  "letta": [
    { value: "letta-agent", label: "Letta Agent (auto-routed)" },
  ],
  "openai": [
    { value: "gpt-4o", label: "GPT-4o" },
    { value: "gpt-4o-mini", label: "GPT-4o Mini" },
    { value: "gpt-4.1", label: "GPT-4.1" },
    { value: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    { value: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
  ],
  "openrouter": [
    { value: "anthropic/claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    { value: "openai/gpt-4o", label: "GPT-4o" },
    { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { value: "meta-llama/llama-4-maverick", label: "Llama 4 Maverick" },
  ],
  // gpu-ai cluster models — use the BARE model id exactly as /v1/models lists
  // it. The "openai-proxy/" prefix routes through a dead upstream
  // (ai-llm-inference:8001 → 404 → gateway 500), so the agent never gets a
  // reply. qwen3.6-35b-a3b-fp8 is the house default; the -think suffix toggles
  // CoT for multi-step reasoning.
  "gpu-ai": [
    { value: "qwen3.6-35b-a3b-fp8", label: "Qwen 3.6 35B (Fast, no-think)" },
    { value: "qwen3.6-35b-a3b-fp8-think", label: "Qwen 3.6 35B (Thinking)" },
    { value: "gemma-4-e4b-it", label: "Gemma 4 E4B (fast, low-latency)" },
    { value: "qwen3.5-27b-fp8", label: "Qwen 3.5 27B" },
  ],
  "custom": [],
  "gemini": [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
};

// ── TTS Providers ───────────────────────────────────────────────

export const TTS_PROVIDERS: ProviderOption[] = [
  { value: "gpu-ai", label: "GPU-AI (IndexTTS-2 / Indic Parler)", description: "In-cluster GPU — cloned & named voices" },
  { value: "async", label: "Async (Cloud)", description: "Streaming-first, ultra-low latency TTS", requiresKey: true, keyEnvName: "ASYNC_API_KEY" },
  { value: "elevenlabs", label: "ElevenLabs (Cloud)", description: "Cloud API, premium voices", requiresKey: true, keyEnvName: "ELEVENLABS_API_KEY" },
  { value: "cartesia", label: "Cartesia (Cloud)", description: "Cloud API, fast low-latency TTS", requiresKey: true, keyEnvName: "CARTESIA_API_KEY" },
  { value: "sarvam", label: "Sarvam AI", description: "Indic-focused voices, 7 presets", requiresKey: true, keyEnvName: "SARVAM_API_KEY" },
];

export const TTS_VOICES: Record<string, ModelOption[]> = {
  // Real gpu-ai voice names from mcp-api-server /v1/audio/voices. The
  // builder fetches the full live list dynamically (listProviderVoices);
  // this is just the offline fallback. (The old Sudhir-IndexTTS2 /
  // Indic-Parler-* names did not exist on the endpoint.)
  "gpu-ai": [
    { value: "Sudhir", label: "Sudhir (en)" },
    { value: "Severus", label: "Severus (en)" },
    { value: "SirShree", label: "SirShree (en)" },
    { value: "aditya", label: "Aditya (hi)" },
    { value: "Morgan Freeman", label: "Morgan Freeman (en)" },
    { value: "Julie Andrews", label: "Julie Andrews (en)" },
    { value: "Don LaFontaine", label: "Don LaFontaine (en)" },
  ],
  "elevenlabs": [
    { value: "21m00Tcm4TlvDq8ikWAM", label: "Rachel" },
    { value: "EXAVITQu4vr4xnSDxMaL", label: "Sarah" },
    { value: "onwK4e9ZLuTAKqWW03F9", label: "Daniel" },
  ],
  "cartesia": [
    { value: "a0e99841-438c-4a64-b679-ae501e7d6091", label: "Barbershop Man" },
    { value: "248be419-c632-4f23-adf1-5324ed7dbf1d", label: "British Lady" },
  ],
  "async": [
    { value: "e0f39dc4-f691-4e78-bba5-5c636692cc04", label: "Default" },
  ],
  // Bulbul v2 speaker catalog. The mcp-api-server reference
  // implementation's SARVAM_VOICES lists 9 (also including diya/
  // maitreyi), but livekit-plugins-sarvam 1.6.5's own client-side
  // MODEL_SPEAKER_COMPATIBILITY table for bulbul:v2 — the model
  // agent-template pins for compatibility with this exact voice set,
  // see plugins.py — only accepts these 7; diya/maitreyi 400 against
  // this package version. Confirmed live 2026-07-15 by inspecting the
  // installed package directly. Do not add them back without
  // re-verifying against the then-installed livekit-plugins-sarvam
  // version's compatibility table.
  "sarvam": [
    { value: "anushka", label: "Anushka (female)" },
    { value: "abhilash", label: "Abhilash (male)" },
    { value: "manisha", label: "Manisha (female)" },
    { value: "vidya", label: "Vidya (female)" },
    { value: "arya", label: "Arya (female)" },
    { value: "karun", label: "Karun (male)" },
    { value: "hitesh", label: "Hitesh (male)" },
  ],
};

// Sarvam's supported target_language_code values for TTS synthesis. Only
// consumed by the sarvam provider — its API requires an explicit code (no
// auto-detect). en-IN is first/default to preserve existing agent behavior.
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
