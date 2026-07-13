/**
 * Regression tests for finding #2 (critical): POST /api/session-summary/send
 * was unauthenticated and injected caller-controlled markdown into an outbound
 * email unescaped — an open HTML/phishing relay from a trusted domain.
 *
 * These cover the two defenses:
 *   1. verifyInternalToken — the shared internal-token gate now applied to the
 *      route (mirrors playerUiApi's agent-pod auth).
 *   2. renderSummaryHtml — sanitizes the markdown body and drops non-http(s)
 *      image URLs so no <script>/onerror/javascript: survives into the email.
 *
 * Run: npx tsx --test tests/session-summary-auth.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyInternalToken } from "../server/_core/internalAuth.ts";
import { renderSummaryHtml } from "../server/services/sessionSummaryService.ts";

function reqWith(headers: Record<string, string>) {
  return { header: (n: string) => headers[n.toLowerCase()] };
}

test("verifyInternalToken rejects when a token is configured but header is missing", () => {
  const prev = process.env.AGENT_INTERNAL_TOKEN;
  process.env.AGENT_INTERNAL_TOKEN = "secret-token";
  try {
    assert.equal(verifyInternalToken(reqWith({})), false);
    assert.equal(verifyInternalToken(reqWith({ "x-internal-token": "wrong" })), false);
    assert.equal(verifyInternalToken(reqWith({ "x-internal-token": "secret-token" })), true);
  } finally {
    if (prev === undefined) delete process.env.AGENT_INTERNAL_TOKEN;
    else process.env.AGENT_INTERNAL_TOKEN = prev;
  }
});

test("verifyInternalToken fails closed in production when no token is configured", () => {
  const prevPlayer = process.env.PLAYER_UI_INTERNAL_TOKEN;
  const prevAgent = process.env.AGENT_INTERNAL_TOKEN;
  const prevEnv = process.env.NODE_ENV;
  delete process.env.PLAYER_UI_INTERNAL_TOKEN;
  delete process.env.AGENT_INTERNAL_TOKEN;
  try {
    process.env.NODE_ENV = "production";
    assert.equal(verifyInternalToken(reqWith({})), false);
    process.env.NODE_ENV = "development";
    assert.equal(verifyInternalToken(reqWith({})), true);
  } finally {
    process.env.NODE_ENV = prevEnv;
    if (prevPlayer !== undefined) process.env.PLAYER_UI_INTERNAL_TOKEN = prevPlayer;
    if (prevAgent !== undefined) process.env.AGENT_INTERNAL_TOKEN = prevAgent;
  }
});

test("renderSummaryHtml strips script tags and event handlers from the markdown body", () => {
  const html = renderSummaryHtml({
    email: "u@example.com",
    sessionTitle: "Alert",
    summaryMarkdown:
      "Hello <script>alert(1)</script> <img src=x onerror=alert(2)> and <a href=\"javascript:alert(3)\">x</a>",
  });
  assert.equal(/<script/i.test(html), false, "no <script>");
  assert.equal(/onerror/i.test(html), false, "no event handlers");
  assert.equal(/javascript:/i.test(html), false, "no javascript: hrefs");
});

test("renderSummaryHtml keeps legitimate markdown formatting", () => {
  const html = renderSummaryHtml({
    email: "u@example.com",
    sessionTitle: "Recap",
    summaryMarkdown: "# Heading\n\n- point one\n- **bold** point",
  });
  assert.match(html, /<h1[^>]*>Heading<\/h1>/i);
  assert.match(html, /<strong>bold<\/strong>/i);
});

test("renderSummaryHtml drops image URLs that are not http(s)", () => {
  const html = renderSummaryHtml({
    email: "u@example.com",
    sessionTitle: "Imgs",
    summaryMarkdown: "body",
    imageUrls: ["javascript:alert(1)", "https://cdn.example.com/ok.png", "data:text/html,evil"],
  });
  assert.equal(html.includes("https://cdn.example.com/ok.png"), true);
  assert.equal(/javascript:alert/i.test(html), false);
  assert.equal(html.includes("data:text/html"), false);
});
