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

/**
 * Regression: the Agent Builder's STT picker for gpu-ai showed the TTS voice
 * list. PROVIDERS was keyed by provider name only and gpu-ai's one entry was
 * the /v1/audio/voices (TTS) endpoint, so asking for the STT pipeline still
 * fetched 191 voices. The fixtures are the in-cluster mcp-api-server's own
 * responses, captured 2026-09-12 (voices fixture trimmed to 8 of 191).
 */
import { readFileSync } from "node:fs";
import { listVoicesForProvider, voiceProviderNeedsKey, fallbackVoicesFor, WITHHELD_STT_MODELS } from "../server/services/voiceProviders.ts";

const MODELS = JSON.parse(readFileSync(new URL("./fixtures/gpu-ai-v1-models.json", import.meta.url), "utf8"));
const VOICES = JSON.parse(readFileSync(new URL("./fixtures/gpu-ai-v1-audio-voices.json", import.meta.url), "utf8"));

/** Serve the two gateway endpoints from the captured payloads; record what was asked. */
function stubGateway() {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    const body = url.endsWith("/v1/models") ? MODELS
      : url.endsWith("/v1/audio/voices") ? VOICES
      : null;
    if (!body) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

test("gpu-ai is supported on both pipelines", () => {
  assert.equal(isSupportedVoiceProvider("gpu-ai", "tts"), true);
  assert.equal(isSupportedVoiceProvider("gpu-ai", "stt"), true);
  const pipelines = listSupportedVoiceProviders().filter((p) => p.key === "gpu-ai").map((p) => p.pipeline).sort();
  assert.deepEqual(pipelines, ["stt", "tts"]);
});

test("gpu-ai STT pipeline lists the gateway's stt-capable models, not its TTS voices", async () => {
  const gw = stubGateway();
  try {
    const models = await listVoicesForProvider("gpu-ai", "", "stt");
    assert.equal(gw.calls.length, 1);
    assert.match(gw.calls[0], /\/v1\/models$/, "STT must read /v1/models");
    const ids = models.map((m) => m.id).sort();
    assert.deepEqual(ids, ["faster-whisper"]);
    const voiceNames = new Set(VOICES.data.voices.map((v: any) => v.name));
    for (const id of ids) assert.equal(voiceNames.has(id), false, `${id} is a TTS voice`);
  } finally {
    gw.restore();
  }
});

test("gpu-ai STT pipeline withholds every WITHHELD_STT_MODELS id from the live list and the fallback alike", async () => {
  const gw = stubGateway();
  try {
    assert.ok(WITHHELD_STT_MODELS.size > 0);
    for (const id of WITHHELD_STT_MODELS.keys()) {
      assert.ok(MODELS.data.some((m: any) => m.id === id && m.capabilities.includes("stt")), `fixture must still advertise ${id}`);
    }
    const live = await listVoicesForProvider("gpu-ai", "", "stt");
    const fallback = fallbackVoicesFor("gpu-ai", "stt");
    for (const id of WITHHELD_STT_MODELS.keys()) {
      assert.equal(live.some((m) => m.id.toLowerCase() === id), false, `${id} offered live`);
      assert.equal(fallback.some((m) => m.id.toLowerCase() === id), false, `${id} offered by fallback`);
    }
  } finally {
    gw.restore();
  }
});

test("the withheld filter compares like the gateway: a differently-cased or padded advertisement is still withheld", async () => {
  const gw = stubGateway();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [{ id: "SenseVoice ", capabilities: ["stt"] }, { id: "faster-whisper", capabilities: ["stt"] }],
  }), { status: 200 })) as typeof fetch;
  try {
    const live = await listVoicesForProvider("gpu-ai", "", "stt");
    assert.deepEqual(live.map((m) => m.id), ["faster-whisper"]);
  } finally {
    globalThis.fetch = realFetch;
    gw.restore();
  }
});

test("gpu-ai STT pipeline drops batch-tier ids: a live voice turn cannot queue behind batch work", async () => {
  const gw = stubGateway();
  try {
    const models = await listVoicesForProvider("gpu-ai", "", "stt");
    assert.ok(MODELS.data.some((m: any) => m.id === "faster-whisper-batch"), "fixture must contain the batch id");
    assert.equal(models.some((m) => m.id.endsWith("-batch")), false);
  } finally {
    gw.restore();
  }
});

test("gpu-ai TTS pipeline still reads /v1/audio/voices", async () => {
  const gw = stubGateway();
  try {
    const voices = await listVoicesForProvider("gpu-ai", "", "tts");
    assert.match(gw.calls[0], /\/v1\/audio\/voices$/);
    assert.equal(voices.length, VOICES.data.voices.length);
    assert.ok(voices.some((v) => v.id === "Severus"));
  } finally {
    gw.restore();
  }
});

test("a provider asked for a pipeline it does not serve is unsupported, not silently answered", () => {
  assert.equal(isSupportedVoiceProvider("deepgram", "stt"), true);
  assert.equal(isSupportedVoiceProvider("deepgram", "tts"), false);
  assert.equal(isSupportedVoiceProvider("elevenlabs", "stt"), false);
  // No pipeline given keeps the old by-name behaviour for callers that only have a key to probe.
  assert.equal(isSupportedVoiceProvider("deepgram"), true);
});

test("a composite provider:pipeline string is not a provider name", () => {
  assert.equal(isSupportedVoiceProvider("gpu-ai:stt"), false);
  assert.equal(isSupportedVoiceProvider("gpu-ai:stt", "stt"), false);
  assert.equal(voiceProviderNeedsKey("gpu-ai:stt"), true);
});

test("the STT fallback for gpu-ai is case-insensitive and holds no TTS voice names", () => {
  const stt = fallbackVoicesFor("GPU-AI", "stt").map((v) => v.id);
  const tts = new Set(fallbackVoicesFor("gpu-ai", "tts").map((v) => v.id));
  assert.ok(stt.length > 0);
  for (const id of stt) assert.equal(tts.has(id), false, `${id} is a TTS fallback voice`);
});

test("the gpu-ai STT fallback offers only ids the live /v1/models list advertises", () => {
  const live = new Set(MODELS.data.filter((m: any) => (m.capabilities || []).includes("stt")).map((m: any) => m.id));
  for (const v of fallbackVoicesFor("gpu-ai", "stt")) assert.ok(live.has(v.id), `${v.id} is not on /v1/models`);
});

test("a fallback is never the other pipeline's list", () => {
  assert.deepEqual(fallbackVoicesFor("elevenlabs", "stt"), []);
  assert.deepEqual(fallbackVoicesFor("cartesia", "stt"), []);
  assert.deepEqual(fallbackVoicesFor("deepgram", "tts"), []);
});

test("prototype property names are not providers", () => {
  for (const name of ["constructor", "__proto__", "toString"]) {
    assert.equal(isSupportedVoiceProvider(name), false, name);
    assert.deepEqual(fallbackVoicesFor(name, "tts"), [], name);
    assert.deepEqual(fallbackVoicesFor(name, "stt"), [], name);
  }
});
