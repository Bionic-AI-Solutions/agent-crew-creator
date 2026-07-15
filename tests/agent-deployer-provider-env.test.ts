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
import { providerEnvName, resolveProviderSecretKey, hasSharedProviderKey } from "../server/services/agentDeployer.ts";

test("providerEnvName maps known cloud providers to their SDK env var", () => {
  assert.equal(providerEnvName("openai"), "OPENAI_API_KEY");
  assert.equal(providerEnvName("openrouter"), "OPENROUTER_API_KEY");
  assert.equal(providerEnvName("anthropic"), "ANTHROPIC_API_KEY");
  assert.equal(providerEnvName("gemini"), "GEMINI_API_KEY");
  assert.equal(providerEnvName("sarvam"), "SARVAM_API_KEY");
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

// Regression test for the bug found live 2026-07-15: this exact check
// used its own independent lowercase-template guess (`${provider}_api_key`)
// instead of reading VAULT_PROPERTY_OVERRIDES, so deploying an agent with
// ttsProvider=sarvam silently never wired SARVAM_API_KEY at all, even
// though k8sClient.ts's ExternalSecret side already had the correct
// uppercase override. Covers one overridden provider (sarvam) and one
// non-overridden provider (gemini) to prove the lookup handles both paths.
test("hasSharedProviderKey reads through VAULT_PROPERTY_OVERRIDES for the exact casing Vault actually uses", () => {
  assert.equal(
    hasSharedProviderKey({ SARVAM_API_KEY: "x" }, "sarvam"),
    true,
  );
  assert.equal(
    hasSharedProviderKey({ sarvam_api_key: "x" }, "sarvam"),
    false,
    "the lowercase templated form must NOT satisfy the check for an overridden provider",
  );
});

test("hasSharedProviderKey falls back to the lowercase template for a non-overridden provider", () => {
  assert.equal(
    hasSharedProviderKey({ gemini_api_key: "x" }, "gemini"),
    true,
  );
  assert.equal(
    hasSharedProviderKey({}, "gemini"),
    false,
  );
});
