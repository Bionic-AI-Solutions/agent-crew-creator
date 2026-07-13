/**
 * Regression test for finding #10 (high): AgentConfigForm reseeded all local
 * form state on every getById refetch, so editing one tab then touching another
 * (which invalidates the shared query) silently discarded unsaved edits.
 * shouldReseedForm reseeds only on identity change.
 *
 * Run: npx tsx --test tests/form-reseed.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReseedForm } from "../client/src/lib/formReseed.ts";

test("reseeds on first load (nothing seeded yet)", () => {
  assert.equal(shouldReseedForm(null, 42), true);
});

test("reseeds when switching to a different agent", () => {
  assert.equal(shouldReseedForm(42, 43), true);
});

test("does NOT reseed on a refetch of the same agent (protects unsaved edits)", () => {
  assert.equal(shouldReseedForm(42, 42), false);
});

test("does not reseed while data is still loading", () => {
  assert.equal(shouldReseedForm(null, undefined), false);
  assert.equal(shouldReseedForm(42, null), false);
});
