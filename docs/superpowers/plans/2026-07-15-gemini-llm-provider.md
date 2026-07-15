# Gemini LLM Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google Gemini (`gemini-2.5-flash`) as a selectable LLM provider for an agent's real-time voice-chat pipeline.

**Architecture:** Gemini's OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/`) lets Gemini plug into the exact same `openai_plugin.LLM(base_url=..., api_key=...)` shape the `openrouter` provider already uses in `agent-template`. The org-wide key already lives in Vault at `secret/shared/api-keys` under `gemini_api_key`; the existing per-agent-key-over-shared-key resolution in `agentDeployer.ts` picks it up automatically once the provider→env-var mapping exists.

**Tech Stack:** TypeScript (Node `node:test`, tsx), Python (pytest), existing `livekit-plugins-openai` SDK (no new dependency).

## Global Constraints

- Provider value across all layers is the literal string `"gemini"` (matches Vault key `gemini_api_key` exactly — confirmed in spec).
- Only one model is exposed for now: `gemini-2.5-flash`. No other Gemini models, no fallback-chain wiring (matches `openrouter`/`anthropic`/`custom` precedent — primary-provider-only).
- Base URL is exactly `https://generativelanguage.googleapis.com/v1beta/openai/` (trailing slash, matches Gemini's documented OpenAI-compat endpoint) for the Python LLM factory, and `https://generativelanguage.googleapis.com/v1beta/openai/models` for the server-side model-discovery/key-validation call.
- Reference spec: `docs/superpowers/specs/2026-07-15-gemini-llm-provider-design.md`.

---

### Task 1: Register Gemini in `shared/providerOptions.ts`

**Files:**
- Modify: `shared/providerOptions.ts:58-93`
- Test: `tests/provider-options.test.ts`

**Interfaces:**
- Consumes: nothing new (uses existing `ProviderOption`/`ModelOption` interfaces already defined at the top of the file).
- Produces: `LLM_PROVIDERS` contains a `{ value: "gemini", ... }` entry; `LLM_MODELS["gemini"]` contains `[{ value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" }]`. Later tasks (2, 3, 4) rely on the string `"gemini"` matching this value exactly.

- [ ] **Step 1: Add failing assertions to the existing test file**

Add these two lines inside the existing `"cloud providers still require a key"` test in `tests/provider-options.test.ts` (do not create a new test block — extend the existing one, right after the `openrouter` assertion):

```ts
  assert.equal(providerRequiresKey(LLM_PROVIDERS, "openrouter"), true);
  assert.equal(providerRequiresKey(LLM_PROVIDERS, "gemini"), true);
```

Also add a new, separate test at the end of the file:

```ts
test("gemini LLM provider exposes gemini-2.5-flash as its only model", () => {
  const gemini = LLM_MODELS["gemini"];
  assert.ok(gemini, "LLM_MODELS.gemini must exist");
  assert.deepEqual(
    gemini.map((m) => m.value),
    ["gemini-2.5-flash"],
  );
});
```

This requires adding `LLM_MODELS` to the existing import block at the top of the file:

```ts
import {
  providerRequiresKey,
  STT_PROVIDERS,
  LLM_PROVIDERS,
  LLM_MODELS,
  TTS_PROVIDERS,
} from "../shared/providerOptions.ts";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/provider-options.test.ts`
Expected: FAIL — `gemini LLM provider exposes gemini-2.5-flash as its only model` fails because `LLM_MODELS["gemini"]` is `undefined`, and the `providerRequiresKey(LLM_PROVIDERS, "gemini")` assertion fails because no `gemini` entry exists in `LLM_PROVIDERS` (`providerRequiresKey` returns `false` for unknown providers).

- [ ] **Step 3: Add the Gemini entries**

In `shared/providerOptions.ts`, change:

```ts
  { value: "custom", label: "Custom (OpenAI-compatible)", description: "Self-hosted endpoint", requiresKey: true, keyEnvName: "CUSTOM_LLM_API_KEY" },
];
```

to:

```ts
  { value: "custom", label: "Custom (OpenAI-compatible)", description: "Self-hosted endpoint", requiresKey: true, keyEnvName: "CUSTOM_LLM_API_KEY" },
  { value: "gemini", label: "Gemini", description: "Google Gemini 2.5 Flash — fast, smart, economical", requiresKey: true, keyEnvName: "GEMINI_API_KEY" },
];
```

And change:

```ts
  "custom": [],
```

to:

```ts
  "custom": [],
  "gemini": [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test tests/provider-options.test.ts`
Expected: PASS (all tests in the file, including the two new/modified assertions)

- [ ] **Step 5: Commit**

```bash
git add shared/providerOptions.ts tests/provider-options.test.ts
git commit -m "feat(llm): register Gemini as a selectable LLM provider"
```

---

### Task 2: Wire Gemini's API key into agent deployment (`agentDeployer.ts`)

**Files:**
- Modify: `server/services/agentDeployer.ts:57-78`
- Test: `tests/agent-deployer-provider-env.test.ts` (new file)

**Interfaces:**
- Consumes: the string `"gemini"` (from Task 1's `LLM_PROVIDERS`/`agent.llmProvider` value).
- Produces: `providerEnvName("gemini")` returns `"GEMINI_API_KEY"`. This export is consumed only by this test — `deployAgent()` itself calls the function internally, so no other task depends on the export beyond making it testable.

- [ ] **Step 1: Write the failing test**

`providerEnvName` is currently a private (non-exported) function. Create `tests/agent-deployer-provider-env.test.ts`:

```ts
/**
 * Regression test: providerEnvName must map every cloud LLM/STT/TTS
 * provider value to its SDK-standard env var name so agentDeployer can
 * inject the right key from Vault. Gemini added 2026-07-15.
 *
 * Run: npx tsx --test tests/agent-deployer-provider-env.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { providerEnvName } from "../server/services/agentDeployer.ts";

test("providerEnvName maps known cloud providers to their SDK env var", () => {
  assert.equal(providerEnvName("openai"), "OPENAI_API_KEY");
  assert.equal(providerEnvName("openrouter"), "OPENROUTER_API_KEY");
  assert.equal(providerEnvName("anthropic"), "ANTHROPIC_API_KEY");
  assert.equal(providerEnvName("gemini"), "GEMINI_API_KEY");
});

test("providerEnvName returns null for keyless/unknown providers", () => {
  assert.equal(providerEnvName("gpu-ai"), null);
  assert.equal(providerEnvName("does-not-exist"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/agent-deployer-provider-env.test.ts`
Expected: FAIL — `providerEnvName` is not exported from `agentDeployer.ts` (import resolves to `undefined`, calling it throws `TypeError: providerEnvName is not a function`), and even once exported, `providerEnvName("gemini")` returns `null` since no `"gemini"` case exists yet.

- [ ] **Step 3: Export the function and add the Gemini case**

In `server/services/agentDeployer.ts`, change:

```ts
function providerEnvName(provider: string): string | null {
```

to:

```ts
export function providerEnvName(provider: string): string | null {
```

And change:

```ts
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "deepgram":
```

to:

```ts
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    case "deepgram":
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/agent-deployer-provider-env.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/agentDeployer.ts tests/agent-deployer-provider-env.test.ts
git commit -m "feat(llm): inject GEMINI_API_KEY from Vault when llmProvider=gemini"
```

---

### Task 3: Add Gemini to server-side model discovery / key validation (`llmProviders.ts`)

**Files:**
- Modify: `server/services/llmProviders.ts:45-73`
- Test: `tests/llm-providers.test.ts` (new file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `isSupportedProvider("gemini")` returns `true`; `PROVIDERS["gemini"].modelsUrl === "https://generativelanguage.googleapis.com/v1beta/openai/models"`. Used by the "Test & Save key" UI flow (`listModelsForProvider`) — no other task in this plan depends on it directly.

- [ ] **Step 1: Write the failing test**

Create `tests/llm-providers.test.ts`:

```ts
/**
 * Regression test: Gemini must be registered in llmProviders.ts PROVIDERS
 * so the "Test & Save key" UI flow can validate a Gemini key and list
 * gemini-2.5-flash-family models via listModelsForProvider. Added 2026-07-15.
 *
 * Run: npx tsx --test tests/llm-providers.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSupportedProvider, providerNeedsApiKey } from "../server/services/llmProviders.ts";

test("gemini is a supported provider for live model discovery", () => {
  assert.equal(isSupportedProvider("gemini"), true);
});

test("gemini requires an API key (not an internal/keyless provider)", () => {
  assert.equal(providerNeedsApiKey("gemini"), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/llm-providers.test.ts`
Expected: FAIL on `isSupportedProvider("gemini")` — returns `false` because `PROVIDERS` has no `gemini` key. (`providerNeedsApiKey` already passes since it only special-cases `"gpu-ai"`.)

- [ ] **Step 3: Add the Gemini provider config**

In `server/services/llmProviders.ts`, change:

```ts
  "gpu-ai": {
    key: "gpu-ai",
    label: "Bionic GPU (internal)",
    // Internal cluster URL — only reachable from inside K8s. Server-side
    // call from the platform pod, the user never sees this URL.
    modelsUrl:
      (process.env.GPU_AI_LLM_INTERNAL_URL || "http://mcp-api-server.mcp.svc.cluster.local:8000") +
      "/v1/models",
    // Filter out embeddings + audio-only models to leave just chat LLMs.
    filter: (id) =>
      !/embedding|whisper|tts|parler|index/i.test(id),
  },
};
```

to:

```ts
  "gpu-ai": {
    key: "gpu-ai",
    label: "Bionic GPU (internal)",
    // Internal cluster URL — only reachable from inside K8s. Server-side
    // call from the platform pod, the user never sees this URL.
    modelsUrl:
      (process.env.GPU_AI_LLM_INTERNAL_URL || "http://mcp-api-server.mcp.svc.cluster.local:8000") +
      "/v1/models",
    // Filter out embeddings + audio-only models to leave just chat LLMs.
    filter: (id) =>
      !/embedding|whisper|tts|parler|index/i.test(id),
  },
  gemini: {
    key: "gemini",
    label: "Gemini",
    // Google's OpenAI-compatible endpoint — same shape as openai/openrouter.
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/openai/models",
    filter: (id) => /^gemini-/i.test(id),
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/llm-providers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/services/llmProviders.ts tests/llm-providers.test.ts
git commit -m "feat(llm): add Gemini to server-side model discovery / key validation"
```

---

### Task 4: Add the Gemini branch to the agent runtime's LLM factory (`plugins.py`)

**Files:**
- Modify: `agent-template/src/agent/plugins.py:71-84`
- Test: `agent-template/tests/test_plugins_llm.py` (new file)

**Interfaces:**
- Consumes: `config.settings.llm_provider` / `config.settings.llm_model` (existing pydantic-settings singleton), env var `GEMINI_API_KEY`.
- Produces: `_create_primary_llm()` (aliased as `create_primary_llm`) returns a `livekit.plugins.openai.LLM` instance whose `.model == "gemini-2.5-flash"` (or the configured `llm_model` override) and whose `.provider == "generativelanguage.googleapis.com"` when `settings.llm_provider == "gemini"`.

- [ ] **Step 1: Write the failing test**

Create `agent-template/tests/test_plugins_llm.py`:

```python
"""Regression tests for the Gemini LLM provider branch in plugins.py.

Gemini is wired in via its OpenAI-compatible endpoint (same shape as the
openrouter branch) — no livekit-plugins-google dependency needed. Added
2026-07-15.

Run: python3 -m pytest agent-template/tests/test_plugins_llm.py
  or: python3 agent-template/tests/test_plugins_llm.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest
from config import settings
from agent.plugins import _create_primary_llm


def test_gemini_missing_key_raises(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setattr(settings, "llm_provider", "gemini")
    with pytest.raises(ValueError, match="Gemini API key not configured"):
        _create_primary_llm()


def test_gemini_builds_openai_compatible_client_with_default_model(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-123")
    monkeypatch.setattr(settings, "llm_provider", "gemini")
    monkeypatch.setattr(settings, "llm_model", "")

    result = _create_primary_llm()

    assert result.model == "gemini-2.5-flash"
    assert result.provider == "generativelanguage.googleapis.com"


def test_gemini_respects_llm_model_override(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-123")
    monkeypatch.setattr(settings, "llm_provider", "gemini")
    monkeypatch.setattr(settings, "llm_model", "gemini-2.5-pro")

    result = _create_primary_llm()

    assert result.model == "gemini-2.5-pro"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m pytest agent-template/tests/test_plugins_llm.py -v`
Expected: FAIL — `_create_primary_llm()` raises `ValueError: Unknown LLM provider: gemini` (the current final `raise ValueError` in the function) instead of the Gemini-specific behavior, for all three tests.

- [ ] **Step 3: Add the Gemini branch**

In `agent-template/src/agent/plugins.py`, change:

```python
    if provider == "openrouter":
        # OpenRouter is OpenAI-compatible. Key is injected as
        # OPENROUTER_API_KEY env var by agentDeployer.providerEnvName.
        import os
        api_key = os.environ.get("OPENROUTER_API_KEY", "")
        if not api_key:
            raise ValueError("OpenRouter API key not configured (expected OPENROUTER_API_KEY env)")
        return openai_plugin.LLM(
            model=settings.llm_model or "openai/gpt-4o-mini",
            base_url="https://openrouter.ai/api/v1",
            api_key=api_key,
            timeout=httpx.Timeout(connect=15.0, read=60.0, write=15.0, pool=15.0),
        )

    if provider == "anthropic":
```

to:

```python
    if provider == "openrouter":
        # OpenRouter is OpenAI-compatible. Key is injected as
        # OPENROUTER_API_KEY env var by agentDeployer.providerEnvName.
        import os
        api_key = os.environ.get("OPENROUTER_API_KEY", "")
        if not api_key:
            raise ValueError("OpenRouter API key not configured (expected OPENROUTER_API_KEY env)")
        return openai_plugin.LLM(
            model=settings.llm_model or "openai/gpt-4o-mini",
            base_url="https://openrouter.ai/api/v1",
            api_key=api_key,
            timeout=httpx.Timeout(connect=15.0, read=60.0, write=15.0, pool=15.0),
        )

    if provider == "gemini":
        # Gemini's OpenAI-compatible endpoint — same shape as openrouter.
        # Key is injected as GEMINI_API_KEY env var by
        # agentDeployer.providerEnvName, sourced from Vault
        # secret/shared/api-keys:gemini_api_key (or a per-agent override).
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

    if provider == "anthropic":
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m pytest agent-template/tests/test_plugins_llm.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add agent-template/src/agent/plugins.py agent-template/tests/test_plugins_llm.py
git commit -m "feat(llm): add Gemini branch to the agent runtime's LLM factory"
```

---

### Task 5: Live verification against real infra

**Files:** none (verification only — no code changes)

**Interfaces:**
- Consumes: all of Tasks 1–4 deployed together (this task exercises the full stack: UI → DB → K8s deploy → running agent → live voice session).
- Produces: nothing consumed by later tasks — this is the terminal verification task.

Per this project's ground rule that integration/E2E checks run against real infrastructure (not mocks), this task is manual/live rather than an automated test.

- [ ] **Step 1: Rebuild and redeploy the platform + agent image**

Follow the project's existing build/push/deploy flow (same one used for any `agent-template` or server change): rebuild the `bionic-agent` image with the Task 4 change, push it, and rebuild/redeploy the `bionic-platform` server with the Tasks 1–3 changes. Confirm both are running:

```bash
kubectl get pods -n bionic-platform -l app=bionic-platform
```

Expected: `1/1 Running`, recent `AGE`.

- [ ] **Step 2: Select Gemini in the Agent Builder UI**

In the crew-creator UI, open an existing test agent (or create one), go to the LLM section, and select provider "Gemini". Confirm the model dropdown shows exactly one option: "Gemini 2.5 Flash". Save the agent.

- [ ] **Step 3: Exercise "Test & Save key" with a per-agent override (optional key path)**

Click "Test & Save key" on the Gemini provider row, paste a valid Gemini API key, and confirm it validates successfully and lists `gemini-*` models (exercises Task 3's `listModelsForProvider` wiring). This is optional — the shared Vault key should work without this step — but confirms the per-agent override path isn't broken.

- [ ] **Step 4: Deploy the agent and confirm the shared Vault key is injected**

Deploy the agent, then confirm the `GEMINI_API_KEY` env var landed on the pod (sourced from the shared Vault key when no per-agent override was saved):

```bash
kubectl get pods -n <app-slug> -l app=<agent-name>
kubectl exec -n <app-slug> deploy/<agent-name> -- printenv GEMINI_API_KEY
```

Expected: pod `Running`, and the env var printed is non-empty (do not paste its value into any chat/log — just confirm it's set).

- [ ] **Step 5: Run a live Playground voice session and confirm Gemini responds**

Open the crew-creator Playground for this agent, start a voice session, and speak a test utterance. Confirm:
- The agent replies coherently (proves the Gemini call succeeded).
- `kubectl logs -n <app-slug> deploy/<agent-name> --tail=50` shows no `"failed to generate LLM completion"` errors for this session, and ideally an LLM metrics line referencing the Gemini response.

- [ ] **Step 6: Confirm the missing-key error path (negative test against real infra)**

Temporarily deploy a second test agent with `llmProvider=gemini` in a namespace/app that has no shared or per-agent Gemini key reachable (or briefly unset `GEMINI_API_KEY` on the deployment) and confirm the pod logs show the exact error from Task 4 (`"Gemini API key not configured (expected GEMINI_API_KEY env)"`) rather than a silent hang or an unrelated crash. Clean up the temporary agent afterward.

No commit for this task — it's verification only. If any step fails, treat it as a bug in the corresponding Task (1–4) and fix there, not by patching around it here.
