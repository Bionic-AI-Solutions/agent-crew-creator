/**
 * Gemini's OpenAI-compatible endpoint returns ids as "models/gemini-2.5-flash",
 * unlike every other provider wired here. The filter was written against the
 * bare form, so it matched none of them and the model picker stayed empty
 * however valid the key was. Verified live 2026-09-09: 55 ids returned, 0
 * matching /^gemini-/, 40 matching models/gemini.
 *
 * Run: npx tsx --test tests/gemini-model-ids.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS_FOR_TEST } from "../server/services/llmProviders.ts";

const gemini = PROVIDERS_FOR_TEST.gemini;

/** A slice of what the endpoint actually returned. */
const LIVE_IDS = [
  "models/gemini-2.5-flash",
  "models/gemini-2.5-pro",
  "models/gemini-2.5-flash-preview-tts",
  "models/gemma-4-26b-a4b-it",
  "models/gemini-flash-latest",
];

const apply = (raw: string) => {
  const id = gemini.normalizeId ? gemini.normalizeId(raw) : raw;
  return gemini.filter && !gemini.filter(id) ? null : id;
};

test("the models/ prefix is stripped", () => {
  assert.equal(gemini.normalizeId!("models/gemini-2.5-flash"), "gemini-2.5-flash");
});

test("a bare id is left alone, so a format change does not double-strip", () => {
  assert.equal(gemini.normalizeId!("gemini-2.5-flash"), "gemini-2.5-flash");
});

test("only a leading prefix is stripped", () => {
  assert.equal(gemini.normalizeId!("gemini-models/x"), "gemini-models/x");
});

test("live-shaped ids survive the filter", () => {
  assert.equal(apply("models/gemini-2.5-flash"), "gemini-2.5-flash");
  assert.equal(apply("models/gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(apply("models/gemini-flash-latest"), "gemini-flash-latest");
});

test("gemma is still excluded — the filter's original intent", () => {
  assert.equal(apply("models/gemma-4-26b-a4b-it"), null);
});

test("the stored id matches the agent template's default model name", () => {
  // plugins.py falls back to "gemini-2.5-flash"; a stored "models/..." value
  // would be a different string reaching the same endpoint.
  assert.equal(apply("models/gemini-2.5-flash"), "gemini-2.5-flash");
});

test("the whole live sample yields the expected count", () => {
  const kept = LIVE_IDS.map(apply).filter(Boolean);
  assert.deepEqual(kept, [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash-preview-tts",
    "gemini-flash-latest",
  ]);
});
