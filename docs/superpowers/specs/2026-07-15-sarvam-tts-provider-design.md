# Sarvam AI TTS provider — design

**Status:** Approved
**Date:** 2026-07-15

## Purpose

Add Sarvam AI as a selectable TTS provider for an agent's real-time voice pipeline, alongside the existing gpu-ai / async / elevenlabs / cartesia choices. Default to the org-wide shared Vault key when no per-agent key is configured — the same restart-only, `secretKeyRef`-based rule already applied uniformly to every other cloud provider (openai, openrouter, gemini, deepgram, async, elevenlabs, cartesia) as of the Gemini LLM provider work (2026-07-15, see that day's Gemini plan/spec addendum).

## Approach

Sarvam has a real, native `livekit-plugins-sarvam` package (v1.6.5, matches this project's `livekit-agents>=1.5.0` / other plugin versions already in use) — confirmed installed and inspected locally. This follows the same shape as the existing `elevenlabs`/`cartesia` branches in `agent-template/src/agent/plugins.py`: a direct SDK plugin call, not an OpenAI-compat shim (unlike Gemini, which had no native plugin and used the OpenAI-compat endpoint trick instead).

Confirmed live: `secret/shared/api-keys` in Vault already has a Sarvam key — but stored as `SARVAM_API_KEY` (uppercase), breaking the `${provider}_api_key` (lowercase) naming convention every other shared provider key follows. This is exactly the class of bug that broke the whole `${namespace}-secrets` ExternalSecret sync during the Gemini rollout (the `groq`/`anthropic` incident — ExternalSecrets Operator fails the ENTIRE sync, not just the one missing entry, when any `data:` remoteRef points at a nonexistent Vault property). Sarvam's entry must reference the exact existing casing (`SARVAM_API_KEY`), not the templated lowercase form, and this must be verified against live Vault before shipping — not assumed.

## Changes

1. **`shared/providerOptions.ts`**
   - `TTS_PROVIDERS`: add
     ```ts
     { value: "sarvam", label: "Sarvam AI", description: "Indic-focused voices, 9 presets", requiresKey: true, keyEnvName: "SARVAM_API_KEY" }
     ```
   - `TTS_VOICES`: add
     ```ts
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
     ]
     ```
     (First entry, `anushka`, is the default via the existing client-side "auto-select first model" effect — same mechanism Gemini's single-model dropdown relies on.)

2. **`agent-template/pyproject.toml`** and **`agent-template/Dockerfile`**
   - Add `livekit-plugins-sarvam` to the same unconditional install tier as `livekit-plugins-deepgram`/`livekit-plugins-cartesia`/`livekit-plugins-elevenlabs` (not gated behind an optional extra — those three aren't either, despite `pyproject.toml`'s `[project.optional-dependencies]` groups listing some of them; the Dockerfile's `pip install` list is the actual source of truth for what ships in the image).

3. **`agent-template/src/agent/plugins.py`**
   - `_create_primary_tts()`: add a `sarvam` branch —
     ```python
     if provider == "sarvam":
         from livekit.plugins import sarvam
         return sarvam.TTS(
             speaker=settings.tts_voice or "anushka",
             api_key=settings.sarvam_api_key or None,
         )
     ```
   - `config.py`: add `sarvam_api_key: str = ""` alongside the other fallback-provider key fields. The `sarvam` branch reads it via `settings.sarvam_api_key`, matching its true siblings — every other *native-plugin* TTS branch (`cartesia`, `elevenlabs`, `async`) reads through a `settings.X_api_key` pydantic field, not a raw `os.environ.get(...)` call. (Only the OpenAI-compat branches — `openrouter`, `gemini` — read the raw env var directly, because they predate/bypass the settings field for that specific shape; sarvam is not one of those.)

4. **`server/services/agentDeployer.ts`**
   - `providerEnvName()`: add `case "sarvam": return "SARVAM_API_KEY";`

5. **`server/k8sClient.ts`**
   - `SHARED_KEY_PROVIDERS` gains `"sarvam"`.
   - `buildSharedProviderKeyDataEntries()` gains a small `VAULT_PROPERTY_OVERRIDES: Record<string, string>` map (currently just `{ sarvam: "SARVAM_API_KEY" }`), consulted before falling back to the templated `${provider}_api_key` form:
     ```ts
     const VAULT_PROPERTY_OVERRIDES: Record<string, string> = {
       // Vault's secret/shared/api-keys stores this one uppercase, unlike
       // every other provider's lowercase `<provider>_api_key` — verified
       // live 2026-07-15. Referencing the wrong casing here doesn't just
       // leave this one key unresolved: ExternalSecrets Operator fails the
       // ENTIRE ${namespace}-secrets sync when any data: remoteRef points
       // at a nonexistent Vault property (the groq/anthropic incident,
       // same day). Add further entries here only when confirmed live
       // against Vault, never assumed from the general naming convention.
       sarvam: "SARVAM_API_KEY",
     };
     ```
     `buildSharedProviderKeyDataEntries()`'s `.map()` then does `property: VAULT_PROPERTY_OVERRIDES[provider] ?? \`${provider}_api_key\`` instead of the current unconditional template.

## Out of scope

- Runtime fallback chain — sarvam is a primary-provider-only choice, same tier as elevenlabs/cartesia/async.
- mcp-api-server's own separate Sarvam TTS engine (used internally by the `gpu-ai` TTS provider path) — different secret (`mcp-tts-api-keys`), different code path, unrelated to this change.
- Retrofitting the Vault-property-casing-override mechanism for any provider other than sarvam — none of the other 7 shared-key providers need it (all confirmed lowercase-matching already).

## Testing

- Unit test: `buildSharedProviderKeyDataEntries()` includes a `sarvam` entry whose `remoteRef.property === "SARVAM_API_KEY"` (exact casing), not the templated lowercase form — a regression test for the exact bug class this design works around.
- Unit test: `providerEnvName("sarvam") === "SARVAM_API_KEY"`; `TTS_VOICES.sarvam` has exactly the 9 expected values with `anushka` first.
- Live verification: deploy a test agent with `ttsProvider: "sarvam"`, no per-agent key — confirm the ExternalSecret still reports `SecretSynced: True` (not broken, matching the groq/anthropic lesson), confirm `SARVAM_API_KEY` resolves via `secretKeyRef` in the pod, and confirm real synthesized speech in a live Playground session.
