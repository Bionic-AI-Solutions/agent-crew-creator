/**
 * Regression test: Sarvam has no free key-validation endpoint (the
 * reference mcp-api-server implementation notes "a 1-char synth is the
 * cheapest auth probe"), so its voiceProviders.ts entry must send a
 * real Sarvam-shaped synthesis body, not the empty {} every other POST
 * provider gets — this exercises the new VoiceProviderConfig.body field.
 * Added 2026-07-15.
 *
 * Run: npx tsx --test tests/voice-providers.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSupportedVoiceProvider, listSupportedVoiceProviders } from "../server/services/voiceProviders.ts";

test("sarvam is a supported voice provider", () => {
  assert.equal(isSupportedVoiceProvider("sarvam"), true);
});

test("sarvam is registered on the tts pipeline", () => {
  const entry = listSupportedVoiceProviders().find((p) => p.key === "sarvam");
  assert.ok(entry, "sarvam must be listed");
  assert.equal(entry.pipeline, "tts");
});
