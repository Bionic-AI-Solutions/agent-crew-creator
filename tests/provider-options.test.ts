/**
 * Regression test for finding #9 (high): `letta` (LLM) and `faster-whisper`
 * (STT) are keyless providers that route through in-cluster services, but the
 * key-input UI was gated on hardcoded lists that only excluded gpu-ai/custom,
 * so selecting them showed a "Test & Save key" button that threw
 * PRECONDITION_FAILED on click. The UI now gates on providerRequiresKey.
 *
 * Run: npx tsx --test tests/provider-options.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  providerRequiresKey,
  STT_PROVIDERS,
  LLM_PROVIDERS,
  LLM_MODELS,
  TTS_PROVIDERS,
  TTS_VOICES,
  TTS_LANGUAGES,
} from "../shared/providerOptions.ts";

test("keyless providers do not require a key (no key UI, no throw)", () => {
  assert.equal(providerRequiresKey(LLM_PROVIDERS, "letta"), false);
  assert.equal(providerRequiresKey(LLM_PROVIDERS, "gpu-ai"), false);
  assert.equal(providerRequiresKey(STT_PROVIDERS, "faster-whisper"), false);
  assert.equal(providerRequiresKey(STT_PROVIDERS, "gpu-ai"), false);
});

test("cloud providers still require a key", () => {
  assert.equal(providerRequiresKey(LLM_PROVIDERS, "openai"), true);
  assert.equal(providerRequiresKey(LLM_PROVIDERS, "openrouter"), true);
  assert.equal(providerRequiresKey(LLM_PROVIDERS, "gemini"), true);
  assert.equal(providerRequiresKey(STT_PROVIDERS, "deepgram"), true);
  assert.equal(providerRequiresKey(TTS_PROVIDERS, "elevenlabs"), true);
  assert.equal(providerRequiresKey(TTS_PROVIDERS, "cartesia"), true);
  assert.equal(providerRequiresKey(TTS_PROVIDERS, "sarvam"), true);
});

test("unknown provider is treated as keyless (safe default)", () => {
  assert.equal(providerRequiresKey(LLM_PROVIDERS, "does-not-exist"), false);
});

test("gemini LLM provider exposes gemini-2.5-flash as its only model", () => {
  const gemini = LLM_MODELS["gemini"];
  assert.ok(gemini, "LLM_MODELS.gemini must exist");
  assert.deepEqual(
    gemini.map((m) => m.value),
    ["gemini-2.5-flash"],
  );
});

test("sarvam TTS provider exposes exactly the 7 bulbul:v2-compatible speaker presets, anushka first", () => {
  const sarvam = TTS_VOICES["sarvam"];
  assert.ok(sarvam, "TTS_VOICES.sarvam must exist");
  assert.deepEqual(
    sarvam.map((v) => v.value),
    ["anushka", "abhilash", "manisha", "vidya", "arya", "karun", "hitesh"],
  );
});

// Regression test: every Sarvam TTS call used to hardcode target_language_code
// to "en-IN", mispronouncing genuine Hindi/Devanagari LLM output. TTS_LANGUAGES
// must expose exactly Sarvam's 11 supported codes, en-IN first/default.
test("TTS_LANGUAGES exposes exactly Sarvam's 11 supported codes, en-IN first", () => {
  assert.deepEqual(
    TTS_LANGUAGES.map((l) => l.value),
    ["en-IN", "bn-IN", "gu-IN", "hi-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN"],
  );
});
