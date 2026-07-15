# Gemini LLM provider — design

**Status:** Approved
**Date:** 2026-07-15

## Purpose

Add Google Gemini as a selectable LLM provider for an agent's real-time chat pipeline (the primary voice-conversation LLM). Goal: a fast, capable, economical model option alongside the existing gpu-ai / OpenAI / OpenRouter / Anthropic / Custom choices. Default and only model: `gemini-2.5-flash`.

## Approach

Gemini exposes an OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/`), so this follows the exact same shape as the existing `openrouter` provider: an `openai_plugin.LLM(base_url=..., api_key=...)` call in `agent-template`. No new Python SDK dependency and no agent image rebuild-for-new-plugin is required.

The org-wide Gemini API key already lives in Vault at `secret/shared/api-keys` under the key `gemini_api_key`, matching the existing shared-fallback-key convention (`${provider}_api_key`) used by every other cloud LLM provider.

## Changes

1. **`shared/providerOptions.ts`**
   - `LLM_PROVIDERS`: add
     ```ts
     { value: "gemini", label: "Gemini", description: "Google Gemini 2.5 Flash — fast, smart, economical", requiresKey: true, keyEnvName: "GEMINI_API_KEY" }
     ```
   - `LLM_MODELS`: add
     ```ts
     "gemini": [{ value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" }]
     ```

2. **`server/services/agentDeployer.ts`**
   - `providerEnvName()`: add `case "gemini": return "GEMINI_API_KEY";`
   - No other changes needed — the existing per-agent-key-over-shared-key resolution (`vault["agent_${id}_gemini_api_key"] || sharedKeys["gemini_api_key"]`) already covers Gemini once the env-name mapping exists.

3. **`agent-template/src/agent/plugins.py`**
   - `_create_primary_llm()`: add a `gemini` branch mirroring the `openrouter` branch —
     ```python
     if provider == "gemini":
         import os
         api_key = os.environ.get("GEMINI_API_KEY", "")
         if not api_key:
             raise ValueError("Gemini API key not configured (expected GEMINI_API_KEY env)")
         return openai_plugin.LLM(
             model=settings.llm_model or "gemini-2.5-flash",
             base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
             api_key=api_key,
             timeout=httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0),
         )
     ```

4. **`server/services/llmProviders.ts`**
   - Add a `gemini` entry to `PROVIDERS` so the existing "Test & Save key" flow can validate a per-agent override key the same way it does for OpenAI/OpenRouter:
     ```ts
     gemini: {
       key: "gemini",
       label: "Gemini",
       modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
       filter: (id) => /^gemini-/i.test(id),
     },
     ```

## Out of scope

- **Runtime fallback chain.** `create_llm_with_fallback()` only auto-adds OpenAI as a fallback today; `anthropic`, `openrouter`, and `custom` are primary-provider-only, same tier Gemini joins. Not wiring Gemini into the `FallbackAdapter` chain matches existing precedent and avoids scope creep.
- **Multiple Gemini model choices.** Only `gemini-2.5-flash` is exposed for now (single-option dropdown, matching the "fast, smart, economical" requirement directly). Flash-Lite / Pro variants can be added later as additional `LLM_MODELS["gemini"]` entries with no other code changes.
- **STT/TTS pipelines.** This is LLM-only; Gemini is not being added as an STT or TTS provider.

## Testing

- Deploy (or redeploy) a test agent with `llmProvider: "gemini"` and no per-agent key set — confirm `GEMINI_API_KEY` env var is injected from the shared Vault key and the agent responds correctly in a live Playground voice session.
- Exercise "Test & Save key" for Gemini in the Agent Builder UI with a per-agent override key — confirm it validates and lists `gemini-2.5-flash`-family models.
- Confirm a bad/missing key produces the expected `ValueError`/deploy-time warning rather than a silent failure (matches `openrouter`'s behavior).
