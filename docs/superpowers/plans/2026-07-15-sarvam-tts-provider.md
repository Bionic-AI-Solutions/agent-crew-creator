# Sarvam AI TTS Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Sarvam AI as a selectable TTS provider (9 real speaker presets), defaulting to the shared org-wide Vault key when no per-agent key is set — the same restart-only `secretKeyRef` rule already applied to every other cloud provider.

**Architecture:** Sarvam has a real, native `livekit-plugins-sarvam` package (confirmed installed and inspected locally) — this follows the `elevenlabs`/`cartesia` native-plugin shape, not Gemini's OpenAI-compat shim. The org-wide key exists in Vault at `secret/shared/api-keys` as `SARVAM_API_KEY` (uppercase — breaks the `${provider}_api_key` lowercase convention every other provider follows), so `k8sClient.ts` needs an explicit per-provider Vault-property override rather than the templated form, to avoid repeating the `groq`/`anthropic` incident (ExternalSecrets Operator fails the *entire* namespace's secret sync if any one `data:` remoteRef points at a nonexistent Vault property). Sarvam also has no free key-validation endpoint — the "Test & Save key" flow needs a real (billed) 1-word synthesis call, which requires extending `voiceProviders.ts`'s POST-body handling (currently hardcoded to an empty `{}` for every POST provider).

**Tech Stack:** TypeScript (Node `node:test`, tsx), Python (pytest), `livekit-plugins-sarvam` (new dependency).

## Global Constraints

- Provider value across all layers is the literal string `"sarvam"`.
- **AMENDED during Task 4 implementation (2026-07-15):** the plan originally specified 9 voices (including `diya`/`maitreyi`, from the mcp-api-server reference implementation's `SARVAM_VOICES`). Task 4's implementer discovered — and controller independently verified against the installed `livekit-plugins-sarvam==1.6.5` package's own `MODEL_SPEAKER_COMPATIBILITY` table — that `diya`/`maitreyi` are NOT in `bulbul:v2`'s compatible speaker set for this package version (and `bulbul:v3`, the plugin's own default model, supports NONE of the 9 originally-chosen names at all). The actual, final, shipped voice list is **7 voices**: `anushka`, `abhilash`, `manisha`, `vidya`, `arya`, `karun`, `hitesh` — `anushka` first/default. Tasks 1 and 2's code blocks below still show the original 9-voice version (as actually implemented and reviewed at the time); the correction was applied directly to `shared/providerOptions.ts` and `server/services/voiceProviders.ts` after Task 4 surfaced it, with matching test updates. Do not re-add `diya`/`maitreyi` without re-verifying against the then-installed package version's compatibility table.
- The shared Vault property for sarvam's key is exactly `SARVAM_API_KEY` (uppercase) — confirmed live against `secret/shared/api-keys` on 2026-07-15. Do not assume the lowercase templated form; do not add further `VAULT_PROPERTY_OVERRIDES` entries without confirming live against Vault first.
- No provider API key value is ever baked as a literal string into a K8s manifest — sarvam must go through `secretKeyRef`, matching every other provider since the 2026-07-15 retrofit.
- No runtime fallback-chain wiring — sarvam is primary-provider-only, same tier as `elevenlabs`/`cartesia`/`async`.
- Reference spec: `docs/superpowers/specs/2026-07-15-sarvam-tts-provider-design.md`.

---

### Task 1: Register Sarvam in `shared/providerOptions.ts`

**Files:**
- Modify: `shared/providerOptions.ts:100-135`
- Test: `tests/provider-options.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TTS_PROVIDERS` contains `{ value: "sarvam", ... }`. `TTS_VOICES["sarvam"]` contains exactly the 9 voices listed in Global Constraints, in that order.

- [ ] **Step 1: Write the failing tests**

Add to the existing `"cloud providers still require a key"` test in `tests/provider-options.test.ts` (right after the `cartesia` assertion):

```ts
  assert.equal(providerRequiresKey(TTS_PROVIDERS, "cartesia"), true);
  assert.equal(providerRequiresKey(TTS_PROVIDERS, "sarvam"), true);
```

Add `TTS_VOICES` to the existing import block:

```ts
import {
  providerRequiresKey,
  STT_PROVIDERS,
  LLM_PROVIDERS,
  LLM_MODELS,
  TTS_PROVIDERS,
  TTS_VOICES,
} from "../shared/providerOptions.ts";
```

Add a new test at the end of the file:

```ts
test("sarvam TTS provider exposes exactly its 9 real speaker presets, anushka first", () => {
  const sarvam = TTS_VOICES["sarvam"];
  assert.ok(sarvam, "TTS_VOICES.sarvam must exist");
  assert.deepEqual(
    sarvam.map((v) => v.value),
    ["anushka", "abhilash", "manisha", "vidya", "arya", "karun", "hitesh", "diya", "maitreyi"],
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test tests/provider-options.test.ts`
Expected: FAIL — `providerRequiresKey(TTS_PROVIDERS, "sarvam")` returns `false` (no `sarvam` entry yet), and `TTS_VOICES["sarvam"]` is `undefined`.

- [ ] **Step 3: Add the Sarvam entries**

In `shared/providerOptions.ts`, change:

```ts
export const TTS_PROVIDERS: ProviderOption[] = [
  { value: "gpu-ai", label: "GPU-AI (IndexTTS-2 / Indic Parler)", description: "In-cluster GPU — cloned & named voices" },
  { value: "async", label: "Async (Cloud)", description: "Streaming-first, ultra-low latency TTS", requiresKey: true, keyEnvName: "ASYNC_API_KEY" },
  { value: "elevenlabs", label: "ElevenLabs (Cloud)", description: "Cloud API, premium voices", requiresKey: true, keyEnvName: "ELEVENLABS_API_KEY" },
  { value: "cartesia", label: "Cartesia (Cloud)", description: "Cloud API, fast low-latency TTS", requiresKey: true, keyEnvName: "CARTESIA_API_KEY" },
];
```

to:

```ts
export const TTS_PROVIDERS: ProviderOption[] = [
  { value: "gpu-ai", label: "GPU-AI (IndexTTS-2 / Indic Parler)", description: "In-cluster GPU — cloned & named voices" },
  { value: "async", label: "Async (Cloud)", description: "Streaming-first, ultra-low latency TTS", requiresKey: true, keyEnvName: "ASYNC_API_KEY" },
  { value: "elevenlabs", label: "ElevenLabs (Cloud)", description: "Cloud API, premium voices", requiresKey: true, keyEnvName: "ELEVENLABS_API_KEY" },
  { value: "cartesia", label: "Cartesia (Cloud)", description: "Cloud API, fast low-latency TTS", requiresKey: true, keyEnvName: "CARTESIA_API_KEY" },
  { value: "sarvam", label: "Sarvam AI", description: "Indic-focused voices, 9 presets", requiresKey: true, keyEnvName: "SARVAM_API_KEY" },
];
```

And change:

```ts
  "async": [
    { value: "e0f39dc4-f691-4e78-bba5-5c636692cc04", label: "Default" },
  ],
};
```

to:

```ts
  "async": [
    { value: "e0f39dc4-f691-4e78-bba5-5c636692cc04", label: "Default" },
  ],
  // Bulbul v2 speaker catalog — matches the mcp-api-server reference
  // implementation's SARVAM_VOICES exactly (no live list endpoint exists;
  // this is a fixed preset set per Sarvam's own docs).
  "sarvam": [
    { value: "anushka", label: "Anushka (female)" },
    { value: "abhilash", label: "Abhilash (male)" },
    { value: "manisha", label: "Manisha (female)" },
    { value: "vidya", label: "Vidya (female)" },
    { value: "arya", label: "Arya (female)" },
    { value: "karun", label: "Karun (male)" },
    { value: "hitesh", label: "Hitesh (male)" },
    { value: "diya", label: "Diya (female)" },
    { value: "maitreyi", label: "Maitreyi (female)" },
  ],
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test tests/provider-options.test.ts`
Expected: PASS (6 passing)

- [ ] **Step 5: Commit**

```bash
git add shared/providerOptions.ts tests/provider-options.test.ts
git commit -m "feat(tts): register Sarvam AI as a selectable TTS provider"
```

---

### Task 2: Add Sarvam to server-side voice discovery / key validation (`voiceProviders.ts`)

**Files:**
- Modify: `server/services/voiceProviders.ts:29-221`
- Test: `tests/voice-providers.test.ts` (new file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `isSupportedVoiceProvider("sarvam")` returns `true`. `listVoicesForProvider("sarvam", apiKey)` sends a real POST with a Sarvam-shaped body and returns the same 9-voice static list regardless of response content (mirroring `openai`'s "no live list, hardcoded set, live round-trip only validates the key" pattern). `VoiceProviderConfig` gains an optional `body` field that `listVoicesForProvider` now sends instead of unconditionally hardcoding `{}` for every POST provider — this is additive and backward-compatible (existing `async` provider doesn't set `body`, so it keeps getting `{}` exactly as before).

- [ ] **Step 1: Write the failing tests**

Create `tests/voice-providers.test.ts`:

```ts
/**
 * Regression test: Sarvam has no free key-validation endpoint (the
 * reference mcp-api-server implementation notes "a 1-char synth is the
 * cheapest auth probe"), so its voiceProviders.ts entry must send a
 * real Sarvam-shaped synthesis body, not the empty {} every other POST
 * provider gets — this exercises the new VoiceProviderConfig.body field.
 * Added 2026-07-15.
 *
 * Run: npx tsx --test tests/voice-providers.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSupportedVoiceProvider, listSupportedVoiceProviders } from "../server/services/voiceProviders.ts";

test("sarvam is a supported voice provider", () => {
  assert.equal(isSupportedVoiceProvider("sarvam"), true);
});

test("sarvam is registered on the tts pipeline", () => {
  const entry = listSupportedVoiceProviders().find((p) => p.key === "sarvam");
  assert.ok(entry, "sarvam must be listed");
  assert.equal(entry.pipeline, "tts");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test tests/voice-providers.test.ts`
Expected: FAIL — `isSupportedVoiceProvider("sarvam")` returns `false`, `listSupportedVoiceProviders()` has no `sarvam` entry.

- [ ] **Step 3: Extend `VoiceProviderConfig` with an optional `body` field**

In `server/services/voiceProviders.ts`, change:

```ts
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
```

to:

```ts
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
```

- [ ] **Step 4: Add the Sarvam provider config**

In `server/services/voiceProviders.ts`, change:

```ts
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
```

to:

```ts
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
    listUrl: "https://api.sarvam.ai/text-to-speech",
    method: "POST",
    body: { inputs: ["ok"], target_language_code: "en-IN", speaker: "anushka", model: "bulbul:v2" },
    // Static preset set (no live discovery) — same shape as openai's
    // hardcoded voice list below. Must match TTS_VOICES.sarvam in
    // shared/providerOptions.ts exactly.
    parse: (_raw) => [
      { id: "anushka", name: "Anushka", description: "female" },
      { id: "abhilash", name: "Abhilash", description: "male" },
      { id: "manisha", name: "Manisha", description: "female" },
      { id: "vidya", name: "Vidya", description: "female" },
      { id: "arya", name: "Arya", description: "female" },
      { id: "karun", name: "Karun", description: "male" },
      { id: "hitesh", name: "Hitesh", description: "male" },
      { id: "diya", name: "Diya", description: "female" },
      { id: "maitreyi", name: "Maitreyi", description: "female" },
    ],
  },
  // ── STT side ────────────────────────────────────────────────
```

- [ ] **Step 5: Use `cfg.body` instead of the hardcoded `{}`**

In `server/services/voiceProviders.ts`, change:

```ts
    if (cfg.method === "POST") {
      fetchOpts.body = JSON.stringify({});
    }
```

to:

```ts
    if (cfg.method === "POST") {
      fetchOpts.body = JSON.stringify(cfg.body ?? {});
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx --test tests/voice-providers.test.ts`
Expected: PASS (2 passing)

- [ ] **Step 7: Commit**

```bash
git add server/services/voiceProviders.ts tests/voice-providers.test.ts
git commit -m "feat(tts): add Sarvam to voice discovery / key validation, extend POST body support"
```

---

### Task 3: Wire Sarvam's key delivery in `agentDeployer.ts` and `k8sClient.ts`

**Files:**
- Modify: `server/services/agentDeployer.ts:57-80` (`providerEnvName`)
- Modify: `server/k8sClient.ts:426-469` (`SHARED_KEY_PROVIDERS`, `buildSharedProviderKeyDataEntries`)
- Test: `tests/agent-deployer-provider-env.test.ts`, `tests/k8s-client-provider-secrets.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `providerEnvName("sarvam")` returns `"SARVAM_API_KEY"`. `buildSharedProviderKeyDataEntries()` includes a `sarvam` entry whose `remoteRef.property === "SARVAM_API_KEY"` (exact uppercase — NOT the templated `sarvam_api_key`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/agent-deployer-provider-env.test.ts`'s existing `"providerEnvName maps known cloud providers to their SDK env var"` test:

```ts
  assert.equal(providerEnvName("sarvam"), "SARVAM_API_KEY");
```

Add to `tests/k8s-client-provider-secrets.test.ts`, replacing the existing "covers the 7 reachable cloud providers" test:

```ts
test("buildSharedProviderKeyDataEntries covers the 8 reachable cloud providers with shared_<provider>_api_key target names (groq, anthropic excluded — see k8sClient.ts comment)", () => {
  const entries = buildSharedProviderKeyDataEntries();
  const secretKeys = entries.map((e) => e.secretKey).sort();
  assert.deepEqual(secretKeys, [
    "shared_async_api_key",
    "shared_cartesia_api_key",
    "shared_deepgram_api_key",
    "shared_elevenlabs_api_key",
    "shared_gemini_api_key",
    "shared_openai_api_key",
    "shared_openrouter_api_key",
    "shared_sarvam_api_key",
  ]);
});
```

And add a new test in the same file:

```ts
test("buildSharedProviderKeyDataEntries maps sarvam to the exact uppercase SARVAM_API_KEY Vault property, not the templated lowercase form", () => {
  const entries = buildSharedProviderKeyDataEntries();
  const sarvam = entries.find((e) => e.secretKey === "shared_sarvam_api_key");
  assert.ok(sarvam, "sarvam entry must exist");
  assert.deepEqual(sarvam.remoteRef, { key: "shared/api-keys", property: "SARVAM_API_KEY" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test tests/agent-deployer-provider-env.test.ts tests/k8s-client-provider-secrets.test.ts`
Expected: FAIL — `providerEnvName("sarvam")` returns `null`; no `sarvam` entry exists in `buildSharedProviderKeyDataEntries()`'s output; the "8 reachable" list assertion fails (still 7).

- [ ] **Step 3: Add the `sarvam` case to `providerEnvName`**

In `server/services/agentDeployer.ts`, change:

```ts
    case "gemini":
      return "GEMINI_API_KEY";
    case "deepgram":
```

to:

```ts
    case "gemini":
      return "GEMINI_API_KEY";
    case "sarvam":
      return "SARVAM_API_KEY";
    case "deepgram":
```

- [ ] **Step 4: Add `sarvam` to `SHARED_KEY_PROVIDERS` and add the Vault-property override**

In `server/k8sClient.ts`, change:

```ts
/**
 * The 7 cloud LLM/STT/TTS providers whose API keys flow through
 * agentDeployer.ts's `pipelines` loop. Each gets a shared, org-wide
 * fallback key at secret/shared/api-keys:<provider>_api_key.
 *
 * The inclusion rule is deliberately "reachable via some *_PROVIDERS
 * list in shared/providerOptions.ts", not "providerEnvName has a case
 * for it" — providerEnvName's switch is a superset that includes dead
 * cases with no way to ever be selected. Including an unreachable
 * provider here is actively dangerous, not just inert: ExternalSecrets
 * Operator fails the ENTIRE sync (not just the missing entry) if any
 * one `data:` remoteRef points at a Vault property that doesn't exist.
 * "groq" and "anthropic" are both excluded for this reason — neither
 * appears as a value in LLM_PROVIDERS/STT_PROVIDERS/TTS_PROVIDERS (the
 * "anthropic/claude-sonnet-4-..." strings in LLM_MODELS.openrouter are
 * OpenRouter *model* ids, not a standalone "anthropic" provider value),
 * so agent.llmProvider/sttProvider/ttsProvider can never actually equal
 * either string. Confirmed live 2026-07-15: the jarvis namespace
 * ExternalSecret went to SecretSyncedError — breaking sync for every
 * key in the Secret, including unrelated ones like Langfuse/MinIO —
 * after a groq entry (no matching Vault key) was added.
 */
const SHARED_KEY_PROVIDERS = [
  "openai", "openrouter", "deepgram",
  "cartesia", "elevenlabs", "async", "gemini",
] as const;

/**
 * ExternalSecret `data:` entries pulling each cloud provider's shared,
 * org-wide fallback API key from secret/shared/api-keys into the
 * per-namespace K8s Secret, under a `shared_`-prefixed target key name
 * — distinct from the per-app-path keys the same Secret already gets
 * via `dataFrom` below, so there's no ambiguity about which value a
 * given key name holds. See spec addendum, 2026-07-15.
 */
export function buildSharedProviderKeyDataEntries(): Array<{
  secretKey: string;
  remoteRef: { key: string; property: string };
}> {
  return SHARED_KEY_PROVIDERS.map((provider) => ({
    secretKey: `shared_${provider}_api_key`,
    remoteRef: { key: "shared/api-keys", property: `${provider}_api_key` },
  }));
}
```

to:

```ts
/**
 * The 8 cloud LLM/STT/TTS providers whose API keys flow through
 * agentDeployer.ts's `pipelines` loop. Each gets a shared, org-wide
 * fallback key at secret/shared/api-keys:<provider>_api_key (or the
 * VAULT_PROPERTY_OVERRIDES entry below, for the rare provider whose
 * Vault key doesn't follow that lowercase convention).
 *
 * The inclusion rule is deliberately "reachable via some *_PROVIDERS
 * list in shared/providerOptions.ts", not "providerEnvName has a case
 * for it" — providerEnvName's switch is a superset that includes dead
 * cases with no way to ever be selected. Including an unreachable
 * provider here is actively dangerous, not just inert: ExternalSecrets
 * Operator fails the ENTIRE sync (not just the missing entry) if any
 * one `data:` remoteRef points at a Vault property that doesn't exist.
 * "groq" and "anthropic" are both excluded for this reason — neither
 * appears as a value in LLM_PROVIDERS/STT_PROVIDERS/TTS_PROVIDERS (the
 * "anthropic/claude-sonnet-4-..." strings in LLM_MODELS.openrouter are
 * OpenRouter *model* ids, not a standalone "anthropic" provider value),
 * so agent.llmProvider/sttProvider/ttsProvider can never actually equal
 * either string. Confirmed live 2026-07-15: the jarvis namespace
 * ExternalSecret went to SecretSyncedError — breaking sync for every
 * key in the Secret, including unrelated ones like Langfuse/MinIO —
 * after a groq entry (no matching Vault key) was added.
 */
const SHARED_KEY_PROVIDERS = [
  "openai", "openrouter", "deepgram",
  "cartesia", "elevenlabs", "async", "gemini", "sarvam",
] as const;

/**
 * Vault's secret/shared/api-keys stores this one uppercase, unlike
 * every other provider's lowercase `<provider>_api_key` — verified
 * live 2026-07-15. Referencing the wrong casing here doesn't just
 * leave this one key unresolved: ExternalSecrets Operator fails the
 * ENTIRE ${namespace}-secrets sync when any data: remoteRef points at
 * a nonexistent Vault property (the groq/anthropic incident, same
 * day). Add further entries here only when confirmed live against
 * Vault, never assumed from the general naming convention.
 */
const VAULT_PROPERTY_OVERRIDES: Record<string, string> = {
  sarvam: "SARVAM_API_KEY",
};

/**
 * ExternalSecret `data:` entries pulling each cloud provider's shared,
 * org-wide fallback API key from secret/shared/api-keys into the
 * per-namespace K8s Secret, under a `shared_`-prefixed target key name
 * — distinct from the per-app-path keys the same Secret already gets
 * via `dataFrom` below, so there's no ambiguity about which value a
 * given key name holds. See spec addendum, 2026-07-15.
 */
export function buildSharedProviderKeyDataEntries(): Array<{
  secretKey: string;
  remoteRef: { key: string; property: string };
}> {
  return SHARED_KEY_PROVIDERS.map((provider) => ({
    secretKey: `shared_${provider}_api_key`,
    remoteRef: { key: "shared/api-keys", property: VAULT_PROPERTY_OVERRIDES[provider] ?? `${provider}_api_key` },
  }));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test tests/agent-deployer-provider-env.test.ts tests/k8s-client-provider-secrets.test.ts`
Expected: PASS (all tests in both files, including the updated "8 reachable providers" list and the new sarvam-casing test)

- [ ] **Step 6: Commit**

```bash
git add server/services/agentDeployer.ts server/k8sClient.ts tests/agent-deployer-provider-env.test.ts tests/k8s-client-provider-secrets.test.ts
git commit -m "feat(tts): wire Sarvam key delivery via secretKeyRef, with exact Vault property casing"
```

---

### Task 4: Add the Sarvam branch to the agent runtime's TTS factory (`plugins.py`)

**Files:**
- Modify: `agent-template/pyproject.toml` (dependencies)
- Modify: `agent-template/Dockerfile:14-36` (pip install list)
- Modify: `agent-template/src/config.py:49-56` (`sarvam_api_key` field)
- Modify: `agent-template/src/agent/plugins.py:271-318` (`_create_primary_tts`)
- Test: `agent-template/tests/test_plugins_tts.py` (new file)

**Interfaces:**
- Consumes: `config.settings.tts_provider` / `config.settings.tts_voice` / `config.settings.sarvam_api_key` (existing pydantic-settings singleton, plus the new field), env var `SARVAM_API_KEY` (delivered via `secretKeyRef` per Task 3 — this file is unaffected by that mechanism and keeps reading one plain settings field, exactly like `cartesia_api_key`/`elevenlabs_api_key`).
- Produces: `_create_primary_tts()` returns a `livekit.plugins.sarvam.TTS` instance whose `.speaker` (or equivalent) reflects `settings.tts_voice or "anushka"` when `settings.tts_provider == "sarvam"`.

- [ ] **Step 1: Add the dependency**

In `agent-template/pyproject.toml`, change:

```toml
dependencies = [
    "livekit-agents>=1.5.0",
    "livekit-plugins-silero>=1.0.0",
    "livekit-plugins-openai>=1.0.0",
    "livekit-plugins-turn-detector>=1.0.0",
    "pydantic-settings>=2.0.0",
    "httpx>=0.27.0",
    "langfuse>=3.0.0",
    "opentelemetry-sdk>=1.20.0",
    "opentelemetry-exporter-otlp-proto-http>=1.20.0",
    "opentelemetry-instrumentation-httpx>=0.44b0",
    "Pillow>=10.0.0",
    "minio>=7.2.0",
]
```

to:

```toml
dependencies = [
    "livekit-agents>=1.5.0",
    "livekit-plugins-silero>=1.0.0",
    "livekit-plugins-openai>=1.0.0",
    "livekit-plugins-turn-detector>=1.0.0",
    "livekit-plugins-sarvam>=1.6.0",
    "pydantic-settings>=2.0.0",
    "httpx>=0.27.0",
    "langfuse>=3.0.0",
    "opentelemetry-sdk>=1.20.0",
    "opentelemetry-exporter-otlp-proto-http>=1.20.0",
    "opentelemetry-instrumentation-httpx>=0.44b0",
    "Pillow>=10.0.0",
    "minio>=7.2.0",
]
```

In `agent-template/Dockerfile`, change:

```dockerfile
    "livekit-plugins-deepgram>=1.0.0" \
    "livekit-plugins-cartesia>=1.0.0" \
    "livekit-plugins-elevenlabs>=1.0.0" \
```

to:

```dockerfile
    "livekit-plugins-deepgram>=1.0.0" \
    "livekit-plugins-cartesia>=1.0.0" \
    "livekit-plugins-elevenlabs>=1.0.0" \
    "livekit-plugins-sarvam>=1.6.0" \
```

- [ ] **Step 2: Add the `sarvam_api_key` settings field**

In `agent-template/src/config.py`, change:

```python
    # ── Fallback providers (keys from Vault, not user-configurable) ──
    deepgram_api_key: str = ""
    openai_api_key: str = ""
    openrouter_api_key: str = ""
    anthropic_api_key: str = ""
    cartesia_api_key: str = ""
    elevenlabs_api_key: str = ""
    async_api_key: str = ""
```

to:

```python
    # ── Fallback providers (keys from Vault, not user-configurable) ──
    deepgram_api_key: str = ""
    openai_api_key: str = ""
    openrouter_api_key: str = ""
    anthropic_api_key: str = ""
    cartesia_api_key: str = ""
    elevenlabs_api_key: str = ""
    async_api_key: str = ""
    sarvam_api_key: str = ""
```

- [ ] **Step 3: Write the failing test**

Create `agent-template/tests/test_plugins_tts.py`:

```python
"""Regression tests for the Sarvam AI TTS provider branch in plugins.py.

Sarvam has a real, native livekit-plugins-sarvam package — same shape
as the existing cartesia/elevenlabs branches, not an OpenAI-compat
shim. Added 2026-07-15.

Run: python3 -m pytest agent-template/tests/test_plugins_tts.py
  or: python3 agent-template/tests/test_plugins_tts.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest
from config import settings
from agent.plugins import _create_primary_tts


def test_sarvam_missing_key_raises(monkeypatch):
    monkeypatch.delenv("SARVAM_API_KEY", raising=False)
    monkeypatch.setattr(settings, "tts_provider", "sarvam")
    monkeypatch.setattr(settings, "sarvam_api_key", "")
    with pytest.raises(ValueError, match="Sarvam API key is required"):
        _create_primary_tts()


def test_sarvam_builds_client_with_default_voice(monkeypatch):
    monkeypatch.setattr(settings, "tts_provider", "sarvam")
    monkeypatch.setattr(settings, "sarvam_api_key", "test-key-123")
    monkeypatch.setattr(settings, "tts_voice", "")

    result = _create_primary_tts()

    assert result._api_key == "test-key-123"
    assert result._opts.speaker == "anushka"


def test_sarvam_respects_tts_voice_override(monkeypatch):
    monkeypatch.setattr(settings, "tts_provider", "sarvam")
    monkeypatch.setattr(settings, "sarvam_api_key", "test-key-123")
    monkeypatch.setattr(settings, "tts_voice", "hitesh")

    result = _create_primary_tts()

    assert result._api_key == "test-key-123"
    assert result._opts.speaker == "hitesh"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `python3 -m pytest agent-template/tests/test_plugins_tts.py -v`
Expected: FAIL — `_create_primary_tts()` raises `ValueError: Unknown TTS provider: sarvam` (the current final `raise ValueError` in the function) for all three tests.

- [ ] **Step 5: Add the Sarvam branch**

In `agent-template/src/agent/plugins.py`, change:

```python
    if provider == "async":
        from livekit.plugins.asyncai import tts as asyncai_tts
        return asyncai_tts.TTS(
            api_key=settings.async_api_key or None,
            voice=settings.tts_voice or "e0f39dc4-f691-4e78-bba5-5c636692cc04",
        )

    raise ValueError(f"Unknown TTS provider: {provider}")
```

to:

```python
    if provider == "async":
        from livekit.plugins.asyncai import tts as asyncai_tts
        return asyncai_tts.TTS(
            api_key=settings.async_api_key or None,
            voice=settings.tts_voice or "e0f39dc4-f691-4e78-bba5-5c636692cc04",
        )

    if provider == "sarvam":
        # Native livekit-plugins-sarvam — same shape as cartesia/
        # elevenlabs above, not an OpenAI-compat shim. Key is injected
        # as SARVAM_API_KEY env var by agentDeployer.providerEnvName,
        # sourced via secretKeyRef from the per-namespace Secret (see
        # k8sClient.ts), kept in sync with Vault
        # secret/shared/api-keys:SARVAM_API_KEY (exact uppercase — or a
        # per-agent override) by an ExternalSecret on a 5-minute
        # refresh interval — rotating the key only requires a pod
        # restart, not a redeploy.
        from livekit.plugins import sarvam
        return sarvam.TTS(
            speaker=settings.tts_voice or "anushka",
            api_key=settings.sarvam_api_key or None,
        )

    raise ValueError(f"Unknown TTS provider: {provider}")
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `python3 -m pytest agent-template/tests/test_plugins_tts.py -v`
Expected: PASS (3 passed)

- [ ] **Step 7: Commit**

```bash
git add agent-template/pyproject.toml agent-template/Dockerfile agent-template/src/config.py agent-template/src/agent/plugins.py agent-template/tests/test_plugins_tts.py
git commit -m "feat(tts): add Sarvam branch to the agent runtime's TTS factory"
```

---

### Task 5: Live verification against real infra

**Files:** none (verification only — no code changes)

**Interfaces:**
- Consumes: all of Tasks 1–4 deployed together.
- Produces: nothing consumed by later tasks — terminal verification task.

Per this project's ground rule that integration/E2E checks run against real infrastructure (not mocks), this task is manual/live.

- [ ] **Step 1: Rebuild and redeploy the platform + agent image**

Rebuild `bionic-agent` (Task 4's change) and `bionic-platform` (Tasks 1–3's changes), push both explicit-SHA tags AND the `:latest` tag for `bionic-agent` (the Dockerhub gotcha from the Gemini rollout — building both tags but only pushing one left the cluster running a stale image; push each tag explicitly this time). Redeploy `bionic-platform` to the new tag.

- [ ] **Step 2: Select Sarvam in the Agent Builder UI**

Open a test agent, select TTS provider "Sarvam AI", confirm the voice dropdown shows exactly the 9 expected speakers with "Anushka (female)" as the auto-selected default.

- [ ] **Step 3: Exercise "Test & Save key"**

Click "Test & Save" on the Sarvam provider row with a real key. Confirm it validates successfully (accept that this incurs a real, small Sarvam usage cost per the approved design) and lists the 9 static voices.

- [ ] **Step 4: Deploy and confirm the ExternalSecret synced cleanly**

Deploy the agent, then confirm the target namespace's `ExternalSecret` still reports `Ready: True` / `SecretSynced` (not broken — this is the direct regression check for the exact bug class that broke the Gemini rollout) and that `shared_sarvam_api_key` resolved to a non-empty value in the Secret:

```bash
kubectl get externalsecret -n <app-slug> <app-slug>-secrets -o jsonpath='{.status.conditions}'
kubectl get secret -n <app-slug> <app-slug>-secrets -o jsonpath='{.data.shared_sarvam_api_key}' | base64 -d | wc -c
```

- [ ] **Step 5: Run a live Playground voice session and confirm real Sarvam speech**

Confirm the agent's spoken reply is audibly synthesized by Sarvam (not silently falling through to a different TTS engine), and check pod logs for a successful TTS call with no `sarvam`-related errors.

- [ ] **Step 6: Confirm the missing-key error path**

Temporarily deploy or reconfigure a test agent with `ttsProvider=sarvam` and no reachable key, and confirm the pod logs show the exact error from Task 4 (`"Sarvam API key is required..."`) rather than a silent hang or unrelated crash. Clean up afterward.

No commit for this task — it's verification only. If any step fails, treat it as a bug in the corresponding Task (1–4) and fix there, not by patching around it here.
