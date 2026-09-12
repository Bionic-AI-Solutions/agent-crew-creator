/**
 * The Agent Builder voice/model picker's option list, executed as the real
 * function the component renders from (client/src/components/agents/pickerOptions.ts).
 *
 * Why: the current selection must stay rendered when the search filter hides
 * it (Radix Select blanks the trigger otherwise), and a stored value the
 * provider does not list must be labelled -- judged against the full list,
 * never the filtered one. Both were regressed once during review.
 *
 * Run: npx tsx --test tests/picker-options.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickerOptions } from "../client/src/components/agents/pickerOptions.ts";

const LABEL = "not in the gpu-ai model list";
const voices = [
  { id: "faster-whisper", name: "faster-whisper", description: "systran" },
  { id: "Adam", name: "Adam", description: "en • cloned" },
];

test("value in the list and not filtered out: the list as is, no placeholder", () => {
  assert.deepEqual(pickerOptions(voices, "", "Adam", LABEL), voices);
});

test("value in the list but hidden by the filter: the real entry is prepended, unlabelled", () => {
  const out = pickerOptions(voices, "whisper", "Adam", LABEL);
  assert.deepEqual(out.map((v) => v.id), ["Adam", "faster-whisper"]);
  assert.equal(out[0].description, "en • cloned", "the real entry, not a placeholder");
});

test("value the provider does not list: a labelled placeholder is prepended", () => {
  const out = pickerOptions(voices, "", "Severus", LABEL);
  assert.deepEqual(out[0], { id: "Severus", description: LABEL });
  assert.equal(out.length, voices.length + 1);
});

test("typing in the search box never relabels a valid selection", () => {
  const out = pickerOptions(voices, "zzz-no-match", "Adam", LABEL);
  assert.deepEqual(out.map((v) => v.id), ["Adam"]);
  assert.notEqual(out[0].description, LABEL);
});

test("empty value: filtered list only, no spurious entry", () => {
  assert.deepEqual(pickerOptions(voices, "adam", "", LABEL).map((v) => v.id), ["Adam"]);
  assert.deepEqual(pickerOptions(voices, "", "", LABEL), voices);
});
