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

export const STT_PROVIDERS: ProviderOption[] = [
  { value: "gpu-ai", label: "GPU-AI (Faster Whisper via MCP)", description: "In-cluster GPU, low latency" },
  { value: "faster-whisper", label: "Faster Whisper (Direct)", description: "Direct in-cluster, lowest latency" },
  { value: "deepgram", label: "Deepgram (Cloud)", description: "Cloud API, high accuracy", requiresKey: true, keyEnvName: "DEEPGRAM_API_KEY" },
];

export const STT_MODELS: Record<string, ModelOption[]> = {
  "gpu-ai": [
    { value: "faster-whisper-large-v3", label: "Faster Whisper Large v3" },
    { value: "faster-whisper-large-v3-turbo-ct2", label: "Faster Whisper Large v3 Turbo" },
  ],
  "faster-whisper": [
    { value: "faster-whisper-large-v3-turbo-ct2", label: "Large v3 Turbo (CTranslate2)" },
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
  // gpu-ai cluster models. qwen3.6-35b-a3b-fp8 is the house default
  // (same weights, priority=0 in gpu-ai scheduler). The -think suffix
  // toggles CoT ON for multi-step reasoning — slower but better at
  // derivation. Legacy qwen3.5/gemma-4 names still alias on the
  // gateway but should not be shown in new pickers.
  "gpu-ai": [
    { value: "openai-proxy/qwen3.6-35b-a3b-fp8", label: "Qwen 3.6 35B (Fast, no-think)" },
    { value: "openai-proxy/qwen3.6-35b-a3b-fp8-think", label: "Qwen 3.6 35B (Thinking)" },
  ],
  "custom": [],
};

// ── TTS Providers ───────────────────────────────────────────────

export const TTS_PROVIDERS: ProviderOption[] = [
  { value: "gpu-ai", label: "GPU-AI (IndexTTS-2 / Indic Parler)", description: "In-cluster GPU — cloned & named voices" },
  { value: "elevenlabs", label: "ElevenLabs (Cloud)", description: "Cloud API, premium voices", requiresKey: true, keyEnvName: "ELEVENLABS_API_KEY" },
  { value: "cartesia", label: "Cartesia (Cloud)", description: "Cloud API, fast low-latency TTS", requiresKey: true, keyEnvName: "CARTESIA_API_KEY" },
];

export const TTS_VOICES: Record<string, ModelOption[]> = {
  "gpu-ai": [
    { value: "Sudhir-IndexTTS2", label: "Sudhir (IndexTTS-2 Clone)" },
    { value: "aditya", label: "Aditya (IndexTTS-2 Hindi Male)" },
    { value: "roopa", label: "Roopa (IndexTTS-2 Hindi Female)" },
    { value: "Ash", label: "Ash (English Male)" },
    { value: "Alloy", label: "Alloy (English Neutral)" },
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
};

// ── Letta LLM Models (for secondary agent) ──────────────────────

// Letta (secondary executor) defaults to the thinking variant — this
// brain does the heavy reasoning, so CoT pays off. The no-think variant
// is here for agents that don't need derivation (faster).
export const LETTA_LLM_MODELS: ModelOption[] = [
  { value: "openai-proxy/qwen3.6-35b-a3b-fp8-think", label: "Qwen 3.6 35B (Thinking — GPU, default)" },
  { value: "openai-proxy/qwen3.6-35b-a3b-fp8", label: "Qwen 3.6 35B (Fast, no-think — GPU)" },
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
