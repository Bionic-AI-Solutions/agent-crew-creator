/**
 * Unit tests for registerMcpServer's 409 handling.
 *
 * Run with: npx tsx --test tests/letta-mcp-idempotent.test.ts
 *
 * Uses node:test (no new deps). Stubs global fetch; no Letta needed.
 *
 * Regression cover for: on every agent REdeploy Letta answers 409
 * ("duplicate key ... uix_name_organization_mcp_server") because the server is
 * already registered for the org. That threw, which aborted agentDeployer's
 * wiring block *before* listMcpServerTools/attachToolToAgent ran — so the
 * redeployed agent came up with no MCP tools, while the log blamed the server
 * URL and auth token.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const ENV = ["LETTA_BASE_URL", "LETTA_API_KEY", "LETTA_SERVER_PASSWORD"];
let n = 0;

async function loadLetta(env: Record<string, string>) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, env);
  return (await import(`../server/services/lettaAdmin.js?t=${++n}`)) as
    typeof import("../server/services/lettaAdmin.js");
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return handler(String(input), init);
  }) as typeof fetch;
  return calls;
}

const BASE = { LETTA_BASE_URL: "http://letta.test:8283" };

const DUPLICATE_409 = () =>
  new Response(
    JSON.stringify({
      detail:
        'A unique constraint was violated for MCPServer. Check your input for ' +
        'duplicates: duplicate key value violates unique constraint ' +
        '"uix_name_organization_mcp_server"',
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );

const OK = () => new Response(null, { status: 200 });

test("409 duplicate is treated as already-registered, not an error", async () => {
  const letta = await loadLetta(BASE);
  stubFetch(() => DUPLICATE_409());

  // Must resolve. Before the fix this threw and cost the agent its tools.
  await letta.registerMcpServer({
    name: "jarvis-AJ",
    transport: "streamable-http",
    url: "https://mcp.example/mcp",
  });
});

test("a first registration still succeeds normally", async () => {
  const letta = await loadLetta(BASE);
  const calls = stubFetch(() => OK());

  await letta.registerMcpServer({
    name: "jarvis-AJ",
    transport: "streamable-http",
    url: "https://mcp.example/mcp",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "PUT");
  assert.match(calls[0].url, /\/v1\/tools\/mcp\/servers$/);
});

test("a real failure still throws — 409 is the only status swallowed", async () => {
  const letta = await loadLetta(BASE);
  stubFetch(() => new Response(JSON.stringify({ detail: "bad url" }), {
    status: 400, headers: { "content-type": "application/json" },
  }));

  await assert.rejects(
    () => letta.registerMcpServer({
      name: "jarvis-AJ", transport: "streamable-http", url: "not-a-url",
    }),
    /failed \(400\)/,
  );
});

test("auth failures still throw rather than being hidden", async () => {
  const letta = await loadLetta(BASE);
  stubFetch(() => new Response("unauthorized", { status: 401 }));

  await assert.rejects(
    () => letta.registerMcpServer({
      name: "jarvis-AJ", transport: "streamable-http", url: "https://mcp.example/mcp",
    }),
    /failed \(401\)/,
  );
});

test("errors carry a numeric status so callers can branch on it", async () => {
  const letta = await loadLetta(BASE);
  stubFetch(() => new Response("nope", { status: 503 }));

  await assert.rejects(
    () => letta.registerMcpServer({
      name: "x", transport: "streamable-http", url: "https://mcp.example/mcp",
    }),
    (err: Error & { status?: number }) => {
      assert.equal(err.status, 503, "status must be a property, not just text");
      return true;
    },
  );
});
