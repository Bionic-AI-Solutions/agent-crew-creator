/**
 * The Agent Builder used to demand an API key for every cloud provider, while
 * the deployer happily fell back to the org-wide shared key and ran the pod on
 * it. These cover the precedence the two now share.
 *
 * Run: npx tsx --test tests/provider-key-fallback.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickProviderKey,
  perAgentKeyField,
  sharedKeyField,
} from "../server/_core/providerKeys.ts";

const OVERRIDES = { sarvam: "SARVAM_API_KEY" };

const pick = (args: Partial<Parameters<typeof pickProviderKey>[0]> = {}) =>
  pickProviderKey({
    agentId: 7,
    provider: "gemini",
    appSecrets: {},
    sharedKeys: {},
    overrides: OVERRIDES,
    ...args,
  });

test("a key on the request wins over everything stored", () => {
  const r = pick({
    requestKey: "  from-form  ",
    appSecrets: { agent_7_gemini_api_key: "per-agent" },
    sharedKeys: { gemini_api_key: "shared" },
  });
  assert.equal(r.source, "request");
  assert.equal(r.apiKey, "from-form", "the request key should be trimmed");
});

test("a per-agent override beats the shared key", () => {
  const r = pick({
    appSecrets: { agent_7_gemini_api_key: "per-agent" },
    sharedKeys: { gemini_api_key: "shared" },
  });
  assert.equal(r.source, "agent");
  assert.equal(r.apiKey, "per-agent");
});

test("no per-agent key falls back to the shared key — the point of the change", () => {
  const r = pick({ sharedKeys: { gemini_api_key: "shared" } });
  assert.equal(r.source, "shared");
  assert.equal(r.apiKey, "shared");
});

test("another agent's override is not borrowed", () => {
  const r = pick({ appSecrets: { agent_9_gemini_api_key: "someone-elses" } });
  assert.equal(r.source, "none");
  assert.equal(r.apiKey, undefined);
});

test("a different provider's shared key is not borrowed", () => {
  const r = pick({ sharedKeys: { openai_api_key: "wrong-provider" } });
  assert.equal(r.source, "none");
});

test("nothing anywhere reports none rather than throwing", () => {
  const r = pick();
  assert.equal(r.source, "none");
  assert.equal(r.apiKey, undefined);
});

test("an empty or whitespace request key does not mask the fallback", () => {
  assert.equal(pick({ requestKey: "   ", sharedKeys: { gemini_api_key: "s" } }).source, "shared");
  assert.equal(pick({ requestKey: "", sharedKeys: { gemini_api_key: "s" } }).source, "shared");
});

test("an empty stored value is not treated as a key", () => {
  const r = pick({
    appSecrets: { agent_7_gemini_api_key: "" },
    sharedKeys: { gemini_api_key: "shared" },
  });
  assert.equal(r.source, "shared", "a blank override must not shadow the shared key");
});

test("sarvam's shared field keeps its uppercase name", () => {
  // Vault stores this one as SARVAM_API_KEY, unlike every other provider.
  // Guessing the lowercase convention here is what broke key delivery live
  // on 2026-07-15.
  assert.equal(sharedKeyField("sarvam", OVERRIDES), "SARVAM_API_KEY");
  const r = pick({ provider: "sarvam", sharedKeys: { SARVAM_API_KEY: "sk-sarvam" } });
  assert.equal(r.source, "shared");
  assert.equal(r.apiKey, "sk-sarvam");
});

test("providers without an override use the lowercase convention", () => {
  for (const p of ["openai", "openrouter", "deepgram", "cartesia", "elevenlabs", "async", "gemini"]) {
    assert.equal(sharedKeyField(p, OVERRIDES), `${p}_api_key`);
  }
});

test("the per-agent field name matches what the deployer looks for", () => {
  // agentDeployer builds `agent_${id}_${provider}_api_key` independently;
  // a drift here silently disables every per-agent override.
  assert.equal(perAgentKeyField(13, "cartesia"), "agent_13_cartesia_api_key");
});
