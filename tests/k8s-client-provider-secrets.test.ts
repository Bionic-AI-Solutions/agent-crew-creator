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
import { buildSharedProviderKeyDataEntries, buildSharedBithumanDataEntries, renderProviderExtraEnv } from "../server/k8sClient.ts";
import { LLM_PROVIDERS, STT_PROVIDERS, TTS_PROVIDERS } from "../shared/providerOptions.ts";

test("buildSharedProviderKeyDataEntries covers the 7 reachable cloud providers with shared_<provider>_api_key target names (groq, anthropic excluded — see k8sClient.ts comment)", () => {
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
  ]);
});

test("buildSharedProviderKeyDataEntries excludes groq and anthropic (unreachable via any provider option list; groq also has no Vault key)", () => {
  const entries = buildSharedProviderKeyDataEntries();
  assert.equal(entries.some((e) => e.secretKey.includes("groq")), false);
  assert.equal(entries.some((e) => e.secretKey.includes("anthropic")), false);
});

test("every SHARED_KEY_PROVIDERS entry is reachable via some *_PROVIDERS list (guards against the groq/anthropic bug class generically)", () => {
  const reachable = new Set([
    ...LLM_PROVIDERS.map((p) => p.value),
    ...STT_PROVIDERS.map((p) => p.value),
    ...TTS_PROVIDERS.map((p) => p.value),
  ]);
  const entries = buildSharedProviderKeyDataEntries();
  for (const { secretKey } of entries) {
    const provider = secretKey.replace(/^shared_/, "").replace(/_api_key$/, "");
    assert.ok(
      reachable.has(provider),
      `${provider} is in SHARED_KEY_PROVIDERS but not selectable via any LLM_PROVIDERS/STT_PROVIDERS/TTS_PROVIDERS entry — it can never actually be agent.llmProvider/sttProvider/ttsProvider, so referencing it in the ExternalSecret's data: list risks the same all-or-nothing sync failure groq caused`,
    );
  }
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

test("buildSharedBithumanDataEntries covers all 3 BitHuman fields from secret/shared/bithuman", () => {
  const entries = buildSharedBithumanDataEntries();
  assert.deepEqual(
    entries.map((e) => e.secretKey).sort(),
    ["shared_bithuman_api_key", "shared_bithuman_api_secret", "shared_bithuman_livekit_url"],
  );
  const apiKey = entries.find((e) => e.secretKey === "shared_bithuman_api_key");
  assert.deepEqual(apiKey.remoteRef, { key: "shared/bithuman", property: "bithuman_api_key" });
});
