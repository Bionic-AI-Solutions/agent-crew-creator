# Gemini LLM Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google Gemini (`gemini-2.5-flash`) as a selectable LLM provider for an agent's real-time voice-chat pipeline, and — per mid-implementation feedback (2026-07-15) — put all 9 cloud-provider API keys (openai, openrouter, anthropic, deepgram, cartesia, elevenlabs, groq, async, gemini) on a restart-only key-rotation path instead of the deploy-time-baked-literal path 8 of them currently use.

**Architecture:** Gemini's OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/`) lets Gemini plug into the exact same `openai_plugin.LLM(base_url=..., api_key=...)` shape the `openrouter` provider already uses in `agent-template`. For key delivery: instead of the platform server resolving a Vault value and baking the literal string into the K8s Deployment spec, `agentDeployer.ts` now only decides *which key name* within the per-namespace K8s Secret an env var should reference (`agent_<id>_<provider>_api_key` if a per-agent override exists, else `shared_<provider>_api_key`) — the actual secret material flows Vault → ExternalSecret (5-minute refresh) → K8s Secret → `secretKeyRef`, so rotating a key only requires a pod restart, never a redeploy through the app.

**Tech Stack:** TypeScript (Node `node:test`, tsx), Python (pytest), existing `livekit-plugins-openai` SDK (no new dependency), `external-secrets.io` ExternalSecret (already in use).

## Global Constraints

- Provider value across all layers is the literal string `"gemini"` (matches Vault key `gemini_api_key` exactly — confirmed in spec).
- Only one model is exposed for now: `gemini-2.5-flash`. No other Gemini models, no fallback-chain wiring (matches `openrouter`/`anthropic`/`custom` precedent — primary-provider-only).
- Base URL is exactly `https://generativelanguage.googleapis.com/v1beta/openai/` (trailing slash) for the Python LLM factory, and `https://generativelanguage.googleapis.com/v1beta/openai/models` for the server-side model-discovery/key-validation call.
- **No provider API key value is ever baked as a literal string into a K8s manifest.** The 9 providers routed through `agentDeployer.ts`'s `pipelines` loop (`openai`, `openrouter`, `anthropic`, `deepgram`, `cartesia`, `elevenlabs`, `groq`, `async`, `gemini`) must all resolve to a `secretKeyRef` pointing at a key already present in the per-namespace `${namespace}-secrets` K8s Secret — never a resolved literal value.
- The separate, unconditional `OPENAI_API_KEY` `secretKeyRef` line in `applyAgentDeployment` (serves `create_llm_with_fallback()`'s always-on fallback safety net, independent of the user's explicit provider choice) is a different concern and is not touched by this plan.
- Reference spec: `docs/superpowers/specs/2026-07-15-gemini-llm-provider-design.md` (see the "Addendum: restart-only key rotation" section for the full rationale).

---

### Task 1: Register Gemini in `shared/providerOptions.ts` — COMPLETE

Already implemented, reviewed, and committed (commits `21be70a..3081aaa`, review clean). No further action.

---

### Task 2: Resolve provider secret-key references in `agentDeployer.ts` (covers Gemini + retrofits existing providers)

**Files:**
- Modify: `server/services/agentDeployer.ts:52-78` (`providerEnvName`), `server/services/agentDeployer.ts:472-530` (the `pipelines` resolution loop)
- Test: `tests/agent-deployer-provider-env.test.ts` (new file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `providerEnvName("gemini")` returns `"GEMINI_API_KEY"`. `resolveProviderSecretKey(agentId, provider, hasPerAgentKey)` returns `` `agent_${agentId}_${provider}_api_key` `` when `hasPerAgentKey` is `true`, else `` `shared_${provider}_api_key` ``. Task 3 consumes the *shape* `{ name: string; secretKey: string }` that `extraEnv` now holds (previously `{ name: string; value: string }`).

- [ ] **Step 1: Write the failing tests**

Create `tests/agent-deployer-provider-env.test.ts`:

```ts
/**
 * Regression test: providerEnvName must map every cloud LLM/STT/TTS
 * provider value to its SDK-standard env var name so agentDeployer can
 * reference the right key from the per-namespace Secret. Gemini added
 * 2026-07-15. resolveProviderSecretKey decides which key *name* within
 * that Secret an env var should point at — per-agent override if one
 * exists, else the shared org-wide fallback — without ever touching the
 * key's value, so rotation stays restart-only (see the spec's
 * "Addendum: restart-only key rotation", 2026-07-15).
 *
 * Run: npx tsx --test tests/agent-deployer-provider-env.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { providerEnvName, resolveProviderSecretKey } from "../server/services/agentDeployer.ts";

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

test("resolveProviderSecretKey prefers the per-agent override key name when one exists", () => {
  assert.equal(
    resolveProviderSecretKey(30, "gemini", true),
    "agent_30_gemini_api_key",
  );
});

test("resolveProviderSecretKey falls back to the shared key name when no override exists", () => {
  assert.equal(
    resolveProviderSecretKey(30, "gemini", false),
    "shared_gemini_api_key",
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/agent-deployer-provider-env.test.ts`
Expected: FAIL — `providerEnvName` is not exported (import resolves to `undefined`) and `resolveProviderSecretKey` does not exist yet.

- [ ] **Step 3: Export `providerEnvName`, add the Gemini case, and add `resolveProviderSecretKey`**

In `server/services/agentDeployer.ts`, change:

```ts
function providerEnvName(provider: string): string | null {
```

to:

```ts
export function providerEnvName(provider: string): string | null {
```

Change:

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

Immediately after the `providerEnvName` function's closing brace, add:

```ts
/**
 * Which key *name* within the per-namespace K8s Secret an env var
 * should reference — the per-agent override if one exists in Vault,
 * else the shared org-wide fallback. Only existence is checked by the
 * caller, never the key's value: the secret material itself flows
 * Vault -> ExternalSecret -> K8s Secret -> secretKeyRef, refreshed on a
 * timer, so rotating a key only requires a pod restart, not a redeploy
 * through this app (see spec addendum, 2026-07-15).
 */
export function resolveProviderSecretKey(
  agentId: number,
  provider: string,
  hasPerAgentKey: boolean,
): string {
  return hasPerAgentKey
    ? `agent_${agentId}_${provider}_api_key`
    : `shared_${provider}_api_key`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/agent-deployer-provider-env.test.ts`
Expected: PASS (4 passing)

- [ ] **Step 5: Rewrite the `pipelines` resolution loop to stop baking literal values**

In `server/services/agentDeployer.ts`, change:

```ts
  const extraEnv: Array<{ name: string; value: string }> = [];
  const injected = new Set<string>();
  try {
    const { readAppSecret, readPlatformVaultPath } = await import("../vaultClient.js");
    const vault = (await readAppSecret(app.slug)) || {};

    // Load shared fallback keys (secret/shared/api-keys) once — used when
    // per-agent keys are not configured. This allows agents to work out of
    // the box with shared org-wide keys while still supporting per-agent
    // overrides via the UI's "Test & Save" flow.
    let sharedKeys: Record<string, string> = {};
    try {
      sharedKeys = (await readPlatformVaultPath("shared/api-keys")) || {};
    } catch {
      log.info("No shared API keys found at secret/shared/api-keys");
    }

    const pipelines: Array<["llm" | "stt" | "tts", string | null]> = [
      ["llm", agent.llmProvider],
      ["stt", agent.sttProvider],
      ["tts", agent.ttsProvider],
    ];
    for (const [kind, raw] of pipelines) {
      const provider = (raw || "").toLowerCase();
      if (!provider || provider === "gpu-ai" || provider === "custom") continue;
      const envName = providerEnvName(provider);
      if (!envName) continue;
      if (injected.has(envName)) continue; // already added by another pipeline

      // Priority: per-agent key > shared fallback key
      const perAgentKey = vault[`agent_${agent.id}_${provider}_api_key`];
      const sharedKey = sharedKeys[`${provider}_api_key`];
      const key = perAgentKey || sharedKey;

      if (!key) {
        log.warn("No provider key found (per-agent or shared)", {
          agent: agent.id, pipeline: kind, provider,
        });
        continue;
      }
      extraEnv.push({ name: envName, value: key.trim() });
      injected.add(envName);
      log.info("Injected provider key", {
        agent: agent.id, pipeline: kind, provider, envName,
        source: perAgentKey ? "per-agent" : "shared",
      });
    }
  } catch (err) {
    log.warn("Failed to resolve provider keys (non-fatal)", { error: String(err) });
  }
```

to:

```ts
  const extraEnv: Array<{ name: string; secretKey: string }> = [];
  const injected = new Set<string>();
  try {
    const { readAppSecret, readPlatformVaultPath } = await import("../vaultClient.js");
    const vault = (await readAppSecret(app.slug)) || {};

    // Load shared fallback keys (secret/shared/api-keys) once — used to
    // check *existence* only (never the value) when deciding whether a
    // pipeline has a per-agent override or falls back to the shared
    // org-wide key. The actual key material is delivered to the pod via
    // ExternalSecret + secretKeyRef (see k8sClient.ts), never resolved
    // or baked into a literal value here — see spec addendum, 2026-07-15.
    let sharedKeys: Record<string, string> = {};
    try {
      sharedKeys = (await readPlatformVaultPath("shared/api-keys")) || {};
    } catch {
      log.info("No shared API keys found at secret/shared/api-keys");
    }

    const pipelines: Array<["llm" | "stt" | "tts", string | null]> = [
      ["llm", agent.llmProvider],
      ["stt", agent.sttProvider],
      ["tts", agent.ttsProvider],
    ];
    for (const [kind, raw] of pipelines) {
      const provider = (raw || "").toLowerCase();
      if (!provider || provider === "gpu-ai" || provider === "custom") continue;
      const envName = providerEnvName(provider);
      if (!envName) continue;
      if (injected.has(envName)) continue; // already added by another pipeline

      const hasPerAgentKey = Boolean(vault[`agent_${agent.id}_${provider}_api_key`]);
      const hasSharedKey = Boolean(sharedKeys[`${provider}_api_key`]);

      if (!hasPerAgentKey && !hasSharedKey) {
        log.warn("No provider key found (per-agent or shared)", {
          agent: agent.id, pipeline: kind, provider,
        });
        continue;
      }
      const secretKey = resolveProviderSecretKey(agent.id, provider, hasPerAgentKey);
      extraEnv.push({ name: envName, secretKey });
      injected.add(envName);
      log.info("Wired provider key reference", {
        agent: agent.id, pipeline: kind, provider, envName, secretKey,
        source: hasPerAgentKey ? "per-agent" : "shared",
      });
    }
  } catch (err) {
    log.warn("Failed to resolve provider key references (non-fatal)", { error: String(err) });
  }
```

- [ ] **Step 6: Run tests to verify everything still passes**

Run: `npx tsx --test tests/agent-deployer-provider-env.test.ts`
Expected: PASS (4 passing) — this step only re-confirms Step 4's result since Step 5 doesn't change the tested functions' behavior, only their caller.

- [ ] **Step 7: Commit**

```bash
git add server/services/agentDeployer.ts tests/agent-deployer-provider-env.test.ts
git commit -m "feat(llm): resolve provider secret-key references instead of baking literal values (adds Gemini, restart-only rotation for all 9 cloud providers)"
```

---

### Task 3: Deliver provider keys via `secretKeyRef` in `k8sClient.ts`

**Files:**
- Modify: `server/k8sClient.ts:426-454` (`createExternalSecret`), `server/k8sClient.ts:534-...` (`applyAgentDeployment`)
- Test: `tests/k8s-client-provider-secrets.test.ts` (new file)

**Interfaces:**
- Consumes: the `{ name: string; secretKey: string }` shape Task 2's `extraEnv` now produces.
- Produces: `buildSharedProviderKeyDataEntries()` returns the 9 ExternalSecret `data:` entries. `renderProviderExtraEnv(secretName, extraEnv)` returns the K8s env-entry objects `applyAgentDeployment` splices into its container spec.

- [ ] **Step 1: Write the failing tests**

Create `tests/k8s-client-provider-secrets.test.ts`:

```ts
/**
 * Regression test: provider API keys must reach the agent pod via
 * secretKeyRef (refreshed by ExternalSecret on a timer), never as a
 * literal value baked into the Deployment spec — otherwise rotating a
 * Vault key requires a redeploy instead of just a pod restart. See spec
 * addendum, 2026-07-15.
 *
 * Run: npx tsx --test tests/k8s-client-provider-secrets.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSharedProviderKeyDataEntries, renderProviderExtraEnv } from "../server/k8sClient.ts";

test("buildSharedProviderKeyDataEntries covers all 9 cloud providers with shared_<provider>_api_key target names", () => {
  const entries = buildSharedProviderKeyDataEntries();
  const secretKeys = entries.map((e) => e.secretKey).sort();
  assert.deepEqual(secretKeys, [
    "shared_anthropic_api_key",
    "shared_async_api_key",
    "shared_cartesia_api_key",
    "shared_deepgram_api_key",
    "shared_elevenlabs_api_key",
    "shared_gemini_api_key",
    "shared_groq_api_key",
    "shared_openai_api_key",
    "shared_openrouter_api_key",
  ]);
});

test("buildSharedProviderKeyDataEntries points each entry at shared/api-keys with the matching property", () => {
  const entries = buildSharedProviderKeyDataEntries();
  const gemini = entries.find((e) => e.secretKey === "shared_gemini_api_key");
  assert.ok(gemini, "gemini entry must exist");
  assert.deepEqual(gemini.remoteRef, { key: "shared/api-keys", property: "gemini_api_key" });
});

test("renderProviderExtraEnv produces secretKeyRef entries, never a literal value", () => {
  const rendered = renderProviderExtraEnv("myapp-secrets", [
    { name: "GEMINI_API_KEY", secretKey: "shared_gemini_api_key" },
  ]);
  assert.deepEqual(rendered, [
    {
      name: "GEMINI_API_KEY",
      valueFrom: {
        secretKeyRef: { name: "myapp-secrets", key: "shared_gemini_api_key", optional: true },
      },
    },
  ]);
  // No entry may carry a bare `value` field — that would mean a literal
  // secret string ended up in the rendered K8s manifest.
  for (const entry of rendered) {
    assert.equal("value" in entry, false);
  }
});

test("renderProviderExtraEnv handles an empty list", () => {
  assert.deepEqual(renderProviderExtraEnv("myapp-secrets", []), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/k8s-client-provider-secrets.test.ts`
Expected: FAIL — neither `buildSharedProviderKeyDataEntries` nor `renderProviderExtraEnv` exist yet (import resolves to `undefined`, calls throw `TypeError`).

- [ ] **Step 3: Add `buildSharedProviderKeyDataEntries` and wire it into `createExternalSecret`**

In `server/k8sClient.ts`, immediately before the `createExternalSecret` function, add:

```ts
/**
 * The 9 cloud LLM/STT/TTS providers whose API keys flow through
 * agentDeployer.ts's `pipelines` loop. Each gets a shared, org-wide
 * fallback key at secret/shared/api-keys:<provider>_api_key.
 */
const SHARED_KEY_PROVIDERS = [
  "openai", "openrouter", "anthropic", "deepgram",
  "cartesia", "elevenlabs", "groq", "async", "gemini",
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

Then change:

```ts
        spec: {
          refreshInterval: "5m",
          secretStoreRef: { name: "vault-backend", kind: "ClusterSecretStore" },
          target: { name: `${namespace}-secrets` },
          dataFrom: [{ extract: { key: `t6-apps/${namespace}/config` } }],
        },
```

to:

```ts
        spec: {
          refreshInterval: "5m",
          secretStoreRef: { name: "vault-backend", kind: "ClusterSecretStore" },
          target: { name: `${namespace}-secrets` },
          dataFrom: [{ extract: { key: `t6-apps/${namespace}/config` } }],
          data: buildSharedProviderKeyDataEntries(),
        },
```

- [ ] **Step 4: Add `renderProviderExtraEnv` and wire it into `applyAgentDeployment`**

Immediately before the `applyAgentDeployment` function, add:

```ts
/**
 * Render agentDeployer's { name, secretKey } provider-key references as
 * K8s env entries sourced from the per-namespace Secret via
 * secretKeyRef — never a literal value baked into the Deployment spec,
 * so a Vault key rotation (synced into the Secret by ExternalSecret on
 * its refresh interval) only requires a pod restart to take effect. See
 * spec addendum, 2026-07-15.
 */
export function renderProviderExtraEnv(
  secretName: string,
  extraEnv: Array<{ name: string; secretKey: string }>,
): Array<{ name: string; valueFrom: { secretKeyRef: { name: string; key: string; optional: true } } }> {
  return extraEnv.map(({ name, secretKey }) => ({
    name,
    valueFrom: { secretKeyRef: { name: secretName, key: secretKey, optional: true } },
  }));
}
```

Change the `applyAgentDeployment` signature and its doc comment:

```ts
export async function applyAgentDeployment(
  namespace: string,
  agentName: string,
  image: string,
  configMapName: string,
  secretName: string,
  /** Extra plain env vars (no secret refs). Used for per-agent provider
   *  API keys read from Vault at deploy time — see agentDeployer.ts. */
  extraEnv: Array<{ name: string; value: string }> = [],
): Promise<void> {
```

to:

```ts
export async function applyAgentDeployment(
  namespace: string,
  agentName: string,
  image: string,
  configMapName: string,
  secretName: string,
  /** Provider API key references — rendered as secretKeyRef entries
   *  against the per-namespace Secret, never a literal value. See
   *  agentDeployer.ts and renderProviderExtraEnv. */
  extraEnv: Array<{ name: string; secretKey: string }> = [],
): Promise<void> {
```

Change:

```ts
              // Per-agent provider API keys passed in from agentDeployer.
              ...extraEnv,
            ],
```

to:

```ts
              // Per-agent provider API key references passed in from
              // agentDeployer — rendered as secretKeyRef, never literal.
              ...renderProviderExtraEnv(secretName, extraEnv),
            ],
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test tests/k8s-client-provider-secrets.test.ts`
Expected: PASS (4 passing)

- [ ] **Step 6: Commit**

```bash
git add server/k8sClient.ts tests/k8s-client-provider-secrets.test.ts
git commit -m "feat(llm): deliver provider API keys via secretKeyRef, never a literal Deployment value"
```

---

### Task 4: Add Gemini to server-side model discovery / key validation (`llmProviders.ts`)

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

### Task 5: Add the Gemini branch to the agent runtime's LLM factory (`plugins.py`)

**Files:**
- Modify: `agent-template/src/agent/plugins.py:71-84`
- Test: `agent-template/tests/test_plugins_llm.py` (new file)

**Interfaces:**
- Consumes: `config.settings.llm_provider` / `config.settings.llm_model` (existing pydantic-settings singleton), env var `GEMINI_API_KEY` (now sourced via `secretKeyRef` per Task 3 — this file is unaffected by that change and keeps reading one plain env var name).
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
        # agentDeployer.providerEnvName, sourced via secretKeyRef from
        # the per-namespace Secret (see k8sClient.ts), which is kept in
        # sync with Vault secret/shared/api-keys:gemini_api_key (or a
        # per-agent override) by an ExternalSecret on a 5-minute
        # refresh interval — rotating the key only requires a pod
        # restart, not a redeploy.
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

### Task 6: Live verification against real infra

**Files:** none (verification only — no code changes)

**Interfaces:**
- Consumes: all of Tasks 1–5 deployed together (this task exercises the full stack: UI → DB → K8s deploy → running agent → live voice session, plus the new restart-only rotation path).
- Produces: nothing consumed by later tasks — this is the terminal verification task.

Per this project's ground rule that integration/E2E checks run against real infrastructure (not mocks), this task is manual/live rather than an automated test.

- [ ] **Step 1: Rebuild and redeploy the platform + agent image**

Follow the project's existing build/push/deploy flow: rebuild the `bionic-agent` image with the Task 5 change, push it, and rebuild/redeploy the `bionic-platform` server with the Tasks 1–4 changes. Confirm both are running:

```bash
kubectl get pods -n bionic-platform -l app=bionic-platform
```

Expected: `1/1 Running`, recent `AGE`.

- [ ] **Step 2: Select Gemini in the Agent Builder UI**

In the crew-creator UI, open an existing test agent (or create one), go to the LLM section, and select provider "Gemini". Confirm the model dropdown shows exactly one option: "Gemini 2.5 Flash". Save the agent.

- [ ] **Step 3: Exercise "Test & Save key" with a per-agent override (optional key path)**

Click "Test & Save key" on the Gemini provider row, paste a valid Gemini API key, and confirm it validates successfully and lists `gemini-*` models (exercises Task 4's `listModelsForProvider` wiring). This is optional — the shared Vault key should work without this step — but confirms the per-agent override path isn't broken.

- [ ] **Step 4: Deploy the agent and confirm the ExternalSecret synced the shared key**

Deploy the agent, then confirm the per-namespace Secret actually contains `shared_gemini_api_key` (synced by ESO from `secret/shared/api-keys`) and that the pod's `GEMINI_API_KEY` env var resolves via `secretKeyRef` (not a literal):

```bash
kubectl get externalsecret -n <app-slug> <app-slug>-secrets -o yaml | grep -A2 gemini
kubectl get secret -n <app-slug> <app-slug>-secrets -o jsonpath='{.data.shared_gemini_api_key}' | base64 -d | wc -c
kubectl get deployment -n <app-slug> <agent-name> -o yaml | grep -B2 -A4 GEMINI_API_KEY
```

Expected: the `ExternalSecret` describes the `shared/api-keys` remoteRef; the Secret's `shared_gemini_api_key` field is non-empty (character count > 0, do not print the value itself); the Deployment's `GEMINI_API_KEY` env entry shows `valueFrom.secretKeyRef`, not a bare `value:` string.

- [ ] **Step 5: Run a live Playground voice session and confirm Gemini responds**

Open the crew-creator Playground for this agent, start a voice session, and speak a test utterance. Confirm:
- The agent replies coherently (proves the Gemini call succeeded).
- `kubectl logs -n <app-slug> deploy/<agent-name> --tail=50` shows no `"failed to generate LLM completion"` errors for this session.

- [ ] **Step 6: Confirm restart-only key rotation actually works end-to-end**

This is the core acceptance criterion for the mid-implementation fix. Rotate the Gemini key in Vault at `secret/shared/api-keys` (write a new value — coordinate the actual key rotation with whoever owns that credential), wait for the ExternalSecret's 5-minute refresh (or force it), then restart the pod **without redeploying through the app**:

```bash
kubectl rollout restart deployment/<agent-name> -n <app-slug>
```

Confirm the new key took effect (e.g. re-run Step 5's voice-session check, or check `printenv GEMINI_API_KEY` inside the pod matches the new value's expected length/prefix — do not print the full secret). This proves the redeploy-required bug is actually fixed, not just refactored.

- [ ] **Step 7: Confirm the missing-key error path (negative test against real infra)**

Temporarily deploy a second test agent with `llmProvider=gemini` in a namespace/app that has no shared or per-agent Gemini key reachable, or briefly unset `GEMINI_API_KEY` on the deployment, and confirm the pod logs show the exact error from Task 5 (`"Gemini API key not configured (expected GEMINI_API_KEY env)"`) rather than a silent hang or an unrelated crash. Clean up the temporary agent afterward.

No commit for this task — it's verification only. If any step fails, treat it as a bug in the corresponding Task (2–5) and fix there, not by patching around it here.
