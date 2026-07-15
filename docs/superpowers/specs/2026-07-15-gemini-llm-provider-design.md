# Gemini LLM provider — design

**Status:** Approved
**Date:** 2026-07-15
**Amended:** 2026-07-15 — added the restart-only key rotation addendum below after mid-implementation feedback.

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
   - Key delivery goes through the restart-only mechanism described in the addendum below, not a literal deploy-time-baked value.

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

## Addendum: restart-only key rotation (2026-07-15)

**Problem found mid-implementation.** Two different key-delivery mechanisms already coexist in this codebase:

1. **Restart-only today:** `OPENAI_API_KEY` (fallback-safety-net path only — see below), `LIVEKIT_API_KEY`, `LETTA_API_KEY`, Langfuse, MinIO — wired via `valueFrom.secretKeyRef` in `applyAgentDeployment` (`server/k8sClient.ts`) against the per-namespace `${namespace}-secrets` K8s Secret, which an `ExternalSecret` refreshes from Vault every 5 minutes (`createExternalSecret`, same file). Rotating the Vault value + restarting the pod is enough.
2. **Redeploy-required today:** every provider resolved through `agentDeployer.ts`'s `pipelines` loop (`openrouter`, `anthropic`, `deepgram`, `cartesia`, `elevenlabs`, `groq`, `async`, and — as originally scoped — `gemini` too) — the platform server reads the Vault value itself at deploy time and bakes the literal string into the K8s Deployment spec (`extraEnv.push({ name: envName, value: key.trim() })`). Rotating the Vault key does nothing until the agent is redeployed through the app; a pod restart alone does not pick up the new value.

**Decision (user, 2026-07-15):** fix this properly rather than adding Gemini to the weaker mechanism — retrofit all 7 existing `pipelines`-loop providers plus Gemini onto the restart-only mechanism. Rotating any of these 8 providers' keys should require, at worst, a pod restart.

**Design.** The insight: the per-agent-override-vs-shared-fallback *priority decision* (which one wins) is not itself secret — only the key *value* is. So instead of resolving the value and baking it in, `agentDeployer.ts` only needs to decide, at deploy time, **which key name within the K8s Secret** the env var should point at:

- The per-namespace `${namespace}-secrets` Secret already contains every per-agent override key as-is (`agent_<id>_<provider>_api_key`), via the existing `dataFrom: [{ extract: { key: "t6-apps/<namespace>/config" } }]` — no change needed there.
- `createExternalSecret` (`server/k8sClient.ts`) gains explicit `data:` entries (same pattern `createDockerHubPullSecret` already uses for `shared/dockerhub`) pulling each of the 8 providers' shared fallback keys from `secret/shared/api-keys` into the same `${namespace}-secrets` Secret, under distinct target key names `shared_<provider>_api_key` (distinct from any per-app-path key to avoid ambiguity).
- `applyAgentDeployment`'s `extraEnv` parameter changes shape from `{ name, value }` (literal) to `{ name, secretKey }` (rendered as `valueFrom.secretKeyRef.key`).
- `agentDeployer.ts` still reads Vault at deploy time (unchanged — still needed to build the ConfigMap and other non-secret values), but for these 8 providers it now only checks **existence** of a per-agent override (`Boolean(vault[...])`), never touches the value, and pushes `{ name: envName, secretKey: hasPerAgentKey ? "agent_<id>_<provider>_api_key" : "shared_<provider>_api_key" }`.
- No change to `agent-template`'s Python side — every provider branch in `plugins.py` keeps reading one plain env var name (e.g. `GEMINI_API_KEY`), unaware the value now comes via `secretKeyRef` instead of a literal.
- The existing dedicated `OPENAI_API_KEY` `secretKeyRef` line (`server/k8sClient.ts` — the fallback-safety-net wiring for `create_llm_with_fallback()`, independent of whichever provider is explicitly selected) is untouched; it's a different concern (always-on fallback vs. explicit-selection) and is already restart-only. `openai` also flows through the `pipelines` loop when explicitly selected as a primary provider — that path is retrofitted along with the other 7, consistent with the rest.

**Testing implication:** the deploy-time decision logic (which secret key name to choose, given per-agent-override existence) is pure string/boolean logic and unit-testable without a live cluster. The ExternalSecret/K8s manifest wiring itself is verified via the plan's existing live-infra verification task (redeploy + confirm restart-only rotation end-to-end).

## Out of scope

- **Runtime fallback chain.** `create_llm_with_fallback()` only auto-adds OpenAI as a fallback today; `anthropic`, `openrouter`, and `custom` are primary-provider-only, same tier Gemini joins. Not wiring Gemini into the `FallbackAdapter` chain matches existing precedent and avoids scope creep.
- **Multiple Gemini model choices.** Only `gemini-2.5-flash` is exposed for now (single-option dropdown, matching the "fast, smart, economical" requirement directly). Flash-Lite / Pro variants can be added later as additional `LLM_MODELS["gemini"]` entries with no other code changes.
- **STT/TTS pipelines.** This is LLM-only; Gemini is not being added as an STT or TTS provider.

## Testing

- Deploy (or redeploy) a test agent with `llmProvider: "gemini"` and no per-agent key set — confirm `GEMINI_API_KEY` env var is injected from the shared Vault key and the agent responds correctly in a live Playground voice session.
- Exercise "Test & Save key" for Gemini in the Agent Builder UI with a per-agent override key — confirm it validates and lists `gemini-2.5-flash`-family models.
- Confirm a bad/missing key produces the expected `ValueError`/deploy-time warning rather than a silent failure (matches `openrouter`'s behavior).
