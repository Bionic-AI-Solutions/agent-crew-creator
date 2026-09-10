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
  TTS_PROVIDERS,
  TTS_LANGUAGES,
} from "../shared/providerOptions.ts";

// LLM_MODELS and TTS_VOICES used to be imported here, and two tests asserted
// on their contents. d0a0b80 deleted both tables on purpose: they were a
// second, hand-maintained copy of the gateway's catalogue, and the drift
// between the copies was itself the bug (7 gpu-ai voices listed against 191
// served). The models and voices are fetched live now, so there is nothing
// static left to assert -- and a test that pins a list which is supposed to
// come from the server would just recreate the thing that was removed.
//
// The import was never updated, so this whole FILE has failed to load since
// that commit, taking the four checks below down with it. They are about
// which providers need an API key and which languages Sarvam accepts, none
// of which the refactor touched.

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

// Regression test: every Sarvam TTS call used to hardcode target_language_code
// to "en-IN", mispronouncing genuine Hindi/Devanagari LLM output. TTS_LANGUAGES
// must expose exactly Sarvam's 11 supported codes, en-IN first/default.
test("TTS_LANGUAGES exposes exactly Sarvam's 11 supported codes, en-IN first", () => {
  assert.deepEqual(
    TTS_LANGUAGES.map((l) => l.value),
    ["en-IN", "bn-IN", "gu-IN", "hi-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN"],
  );
});
