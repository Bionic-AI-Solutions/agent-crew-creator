/**
 * Regression test for finding #16 (medium): embed-token origin allowlist was
 * bypassable by omitting the Origin header.
 *
 * Run: npx tsx --test tests/embed-origin.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isEmbedOriginAllowed } from "../server/embedOrigin.ts";

test("unrestricted token (no allowlist) allows any/absent origin", () => {
  assert.equal(isEmbedOriginAllowed(null, undefined), true);
  assert.equal(isEmbedOriginAllowed([], "https://any.example"), true);
});

test("restricted token allows a matching origin", () => {
  assert.equal(isEmbedOriginAllowed(["https://ok.example"], "https://ok.example"), true);
});

test("restricted token rejects a non-matching origin", () => {
  assert.equal(isEmbedOriginAllowed(["https://ok.example"], "https://evil.example"), false);
});

test("restricted token rejects a MISSING origin (the bypass)", () => {
  assert.equal(isEmbedOriginAllowed(["https://ok.example"], undefined), false);
});
