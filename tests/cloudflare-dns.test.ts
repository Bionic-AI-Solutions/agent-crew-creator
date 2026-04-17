/**
 * Unit tests for Cloudflare player UI DNS helpers (mocked fetch).
 * Run: npx tsx --test tests/cloudflare-dns.test.ts
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ZONE_ID;
  delete process.env.CLOUDFLARE_ZONE_NAME;
  delete process.env.PLAYER_UI_DNS_TARGET_IP;
  delete process.env.PLAYER_UI_HOST_SUFFIX;
  delete process.env.CLOUDFLARE_DNS_PROXIED;
  delete process.env.CLOUDFLARE_VAULT_KV_PATH;
});

test("resolveCloudflareDnsConfig returns null when credentials incomplete", async () => {
  const { resolveCloudflareDnsConfig } = await import("../server/services/cloudflareDns.js");
  assert.equal(await resolveCloudflareDnsConfig(), null);
  process.env.CLOUDFLARE_API_TOKEN = "t";
  assert.equal(await resolveCloudflareDnsConfig(), null);
  process.env.PLAYER_UI_DNS_TARGET_IP = "1.1.1.1";
  assert.equal(await resolveCloudflareDnsConfig(), null);
  process.env.CLOUDFLARE_ZONE_ID = "z";
  const c = await resolveCloudflareDnsConfig();
  assert.ok(c);
  assert.equal(c!.apiToken, "t");
  assert.equal(c!.targetIp, "1.1.1.1");
  assert.equal(c!.zoneId, "z");
});

test("mergeCloudflareDnsConfig accepts WAN_IP and zone_ids JSON (live Vault shape)", async () => {
  process.env.PLAYER_UI_HOST_SUFFIX = "baisoln.com";
  const { mergeCloudflareDnsConfig } = await import("../server/services/cloudflareDns.js");
  const c = mergeCloudflareDnsConfig({
    WAN_IP: "203.0.113.77",
    api_token: "test-token",
    zone_ids: JSON.stringify({ "baisoln.com": "zone-json-id-123" }),
  });
  assert.ok(c);
  assert.equal(c!.targetIp, "203.0.113.77");
  assert.equal(c!.zoneId, "zone-json-id-123");
  assert.equal(c!.apiToken, "test-token");
  delete process.env.PLAYER_UI_HOST_SUFFIX;
});

test("ensurePlayerUiARecord POSTs when no existing record", async () => {
  process.env.CLOUDFLARE_API_TOKEN = "token";
  process.env.CLOUDFLARE_ZONE_ID = "zone1";
  process.env.PLAYER_UI_DNS_TARGET_IP = "203.0.113.50";
  process.env.PLAYER_UI_HOST_SUFFIX = "baisoln.com";

  const requests: { url: string; method: string; body?: string }[] = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method || "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ url, method, body });
    if (method === "GET" && url.includes("/dns_records?")) {
      return new Response(JSON.stringify({ success: true, result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "POST" && url.endsWith("/dns_records")) {
      return new Response(JSON.stringify({ success: true, result: { id: "rec1" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: false, errors: [{ code: 0, message: "unexpected" }] }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  };

  const { ensurePlayerUiARecord } = await import("../server/services/cloudflareDns.js");
  await ensurePlayerUiARecord("myapp");

  const cfReqs = requests.filter((r) => r.url.includes("api.cloudflare.com"));
  assert.equal(cfReqs.length, 2, "expected two Cloudflare API calls (list + create)");
  assert.ok(cfReqs[0].url.includes("/zones/zone1/dns_records?"));
  assert.ok(cfReqs[0].url.includes(encodeURIComponent("myapp.baisoln.com")));
  assert.equal(cfReqs[1].method, "POST");
  const body = JSON.parse(cfReqs[1].body || "{}");
  assert.deepEqual(
    { type: body.type, name: body.name, content: body.content, proxied: body.proxied },
    { type: "A", name: "myapp.baisoln.com", content: "203.0.113.50", proxied: false },
  );
});
