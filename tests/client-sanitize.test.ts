/**
 * Regression tests for findings #3 and #11 (critical/high): agent/tool output
 * was rendered via dangerouslySetInnerHTML with no sanitization (playground)
 * or a regex sanitizer bypassable by unquoted attributes (embed widget).
 *
 * sanitizeRichText is the shared DOMPurify-backed replacement. These assert the
 * known XSS vectors are neutralized and legitimate formatting survives.
 *
 * Run: npx tsx --test tests/client-sanitize.test.ts
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { sanitizeRichText, __setPurifierWindowForTest } from "../client/src/lib/sanitizeHtml.ts";

before(() => {
  __setPurifierWindowForTest(new JSDOM("").window);
});

test("strips <script> tags", () => {
  const out = sanitizeRichText("hi <script>alert(1)</script> there");
  assert.equal(/<script/i.test(out), false);
});

test("neutralizes the unquoted-attribute vector that bypassed the regex sanitizer", () => {
  const out = sanitizeRichText("<img src=x onerror=alert(1)>");
  assert.equal(/onerror/i.test(out), false);
});

test("strips <svg onload=...> payloads", () => {
  const out = sanitizeRichText("<svg onload=alert(1)></svg>");
  assert.equal(/onload/i.test(out), false);
  assert.equal(/<svg/i.test(out), false);
});

test("drops javascript: hrefs", () => {
  const out = sanitizeRichText("[click](javascript:alert(1))");
  assert.equal(/javascript:/i.test(out), false);
});

test("keeps legitimate markdown formatting and decorates links", () => {
  const out = sanitizeRichText("**bold** and [a link](https://example.com)");
  assert.match(out, /<strong>bold<\/strong>/i);
  assert.match(out, /href="https:\/\/example\.com"/i);
  assert.match(out, /target="_blank"/i);
  assert.match(out, /rel="noopener noreferrer"/i);
});

test("rewrites S3 image URLs to the platform proxy", () => {
  const out = sanitizeRichText("![img](https://s3.baisoln.com/bucket/a.png)", "https://platform.baisoln.com");
  assert.match(out, /https:\/\/platform\.baisoln\.com\/api\/s3-proxy\/bucket\/a\.png/);
});
