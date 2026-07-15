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
