/**
 * Unit tests for vaultClient's auth layer.
 *
 * Run with: npx tsx --test tests/vault-auth.test.ts
 *
 * Uses node:test (no new deps). Stubs global fetch and points the Kubernetes
 * JWT path at a temp file, so no Vault or cluster is needed.
 *
 * Regression cover for the outage where the platform's static Vault token
 * expired, every read 403'd, and the Playground reported the app as
 * unprovisioned instead of re-authenticating.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_KEYS = [
  "VAULT_ADDR",
  "VAULT_K8S_ROLE",
  "VAULT_K8S_MOUNT",
  "VAULT_K8S_JWT_PATH",
  "VAULT_TOKEN_FILE",
  "VAULT_TOKEN",
  "NODE_ENV",
];

interface Call {
  url: string;
  method: string;
  token: string | null;
}

let moduleCounter = 0;

/** Load a fresh copy of vaultClient with the given env (module state resets). */
async function loadVault(env: Record<string, string>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  return (await import(`../server/vaultClient.js?t=${++moduleCounter}`)) as
    typeof import("../server/vaultClient.js");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Install a fetch stub driven by a queue of handlers; records every call. */
function stubFetch(handlers: Array<(call: Call) => Response>) {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      token: headers["X-Vault-Token"] ?? null,
    };
    calls.push(call);
    const handler = handlers[Math.min(i++, handlers.length - 1)];
    return handler(call);
  }) as typeof fetch;
  return calls;
}

function jwtFile(contents = "sa-jwt-token"): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-auth-"));
  const p = join(dir, "token");
  writeFileSync(p, contents);
  return p;
}

const K8S_ENV = (jwtPath: string) => ({
  VAULT_ADDR: "http://vault.test:8200",
  VAULT_K8S_ROLE: "bionic-platform",
  VAULT_K8S_JWT_PATH: jwtPath,
  NODE_ENV: "production",
});

const LOGIN_OK = (token: string, lease = 3600, renewable = true) =>
  jsonResponse(200, {
    auth: { client_token: token, lease_duration: lease, renewable },
  });

/** A fresh Response per call — a body can only be consumed once. */
const kvOk = () =>
  jsonResponse(200, {
    data: { data: { livekit_api_key: "key", livekit_url: "wss://lk.test" } },
  });

test("kubernetes auth: logs in once, then uses the minted token", async () => {
  const vault = await loadVault(K8S_ENV(jwtFile()));
  const calls = stubFetch([
    () => LOGIN_OK("tok-1"),
    () => kvOk(),
  ]);

  const secret = await vault.readAppSecret("jarvis");

  assert.equal(secret?.livekit_api_key, "key");
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/v1\/auth\/kubernetes\/login$/);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[1].token, "tok-1", "KV read must use the minted token");
});

test("kubernetes auth: caches the token across reads (one login)", async () => {
  const vault = await loadVault(K8S_ENV(jwtFile()));
  const calls = stubFetch([() => LOGIN_OK("tok-1"), () => kvOk()]);

  await vault.readAppSecret("jarvis");
  await vault.readAppSecret("guruji");
  await vault.readAppSecret("tutor");

  const logins = calls.filter((c) => c.url.includes("/auth/kubernetes/login"));
  assert.equal(logins.length, 1, "token should be reused, not re-minted");
  assert.equal(calls.length, 4);
});

test("403 on read: re-authenticates and retries once, then succeeds", async () => {
  const vault = await loadVault(K8S_ENV(jwtFile()));
  let n = 0;
  const calls = stubFetch([
    () => {
      n++;
      if (n === 1) return LOGIN_OK("expired-tok");
      if (n === 2) return jsonResponse(403, { errors: ["permission denied"] });
      if (n === 3) return LOGIN_OK("fresh-tok");
      return kvOk();
    },
  ]);

  const secret = await vault.readAppSecret("jarvis");

  assert.equal(secret?.livekit_api_key, "key", "retry should return real data");
  assert.equal(calls.length, 4);
  assert.equal(calls[1].token, "expired-tok");
  assert.equal(calls[3].token, "fresh-tok", "retry must use the new token");
});

test("403 twice: gives up after one retry and reports failure (returns null)", async () => {
  const vault = await loadVault(K8S_ENV(jwtFile()));
  const calls = stubFetch([
    () => LOGIN_OK("tok-1"),
    () => jsonResponse(403, { errors: ["permission denied"] }),
    () => LOGIN_OK("tok-2"),
    () => jsonResponse(403, { errors: ["permission denied"] }),
  ]);

  const secret = await vault.readAppSecret("jarvis");

  assert.equal(secret, null);
  assert.equal(calls.length, 4, "exactly one retry, no infinite loop");
});

test("static token mode: does not retry (nothing new to mint)", async () => {
  const vault = await loadVault({
    VAULT_ADDR: "http://vault.test:8200",
    VAULT_TOKEN: "static-tok",
    NODE_ENV: "production",
  });
  const calls = stubFetch([
    () => jsonResponse(403, { errors: ["permission denied"] }),
  ]);

  const secret = await vault.readAppSecret("jarvis");

  assert.equal(secret, null);
  assert.equal(calls.length, 1, "static mode cannot re-auth, so no retry");
  assert.equal(calls[0].token, "static-tok");
});

test("token-file mode: reads the token from disk", async () => {
  const p = jwtFile("file-tok-1");
  const vault = await loadVault({
    VAULT_ADDR: "http://vault.test:8200",
    VAULT_TOKEN_FILE: p,
    NODE_ENV: "production",
  });
  const calls = stubFetch([() => kvOk()]);

  await vault.readAppSecret("jarvis");

  assert.equal(calls.length, 1, "no login call in file mode");
  assert.equal(calls[0].token, "file-tok-1");
});

test("token-file mode: re-reads after invalidation, picking up a rotation", async () => {
  const p = jwtFile("old-tok");
  const vault = await loadVault({
    VAULT_ADDR: "http://vault.test:8200",
    VAULT_TOKEN_FILE: p,
    NODE_ENV: "production",
  });
  const calls = stubFetch([() => kvOk()]);

  await vault.readAppSecret("jarvis");
  writeFileSync(p, "rotated-tok");
  vault.invalidateVaultToken();
  await vault.readAppSecret("jarvis");

  assert.equal(calls[0].token, "old-tok");
  assert.equal(calls[1].token, "rotated-tok", "rotation picked up without restart");
});

test("concurrent reads trigger a single login (single-flight)", async () => {
  const vault = await loadVault(K8S_ENV(jwtFile()));
  const calls = stubFetch([
    (call) => (call.url.includes("/auth/") ? LOGIN_OK("tok-1") : kvOk()),
  ]);

  await Promise.all([
    vault.readAppSecret("a"),
    vault.readAppSecret("b"),
    vault.readAppSecret("c"),
    vault.readAppSecret("d"),
  ]);

  const logins = calls.filter((c) => c.url.includes("/auth/kubernetes/login"));
  assert.equal(logins.length, 1, "burst of reads must not stampede Vault");
});

test("production with no auth configured fails loudly", async () => {
  const vault = await loadVault({
    VAULT_ADDR: "http://vault.test:8200",
    NODE_ENV: "production",
  });
  stubFetch([() => kvOk()]);

  assert.equal(vault.vault.isConfigured(), false);
  await assert.rejects(
    () => vault.writeAppSecret("jarvis", { a: "b" }),
    /Vault not configured in production/,
  );
});

test("writes also recover from a 403 (safe: Vault rejected, never applied)", async () => {
  const vault = await loadVault(K8S_ENV(jwtFile()));
  const calls = stubFetch([
    () => LOGIN_OK("tok-1"),
    () => jsonResponse(403, { errors: ["permission denied"] }),
    () => LOGIN_OK("tok-2"),
    () => new Response(null, { status: 204 }),
  ]);

  await vault.writeAppSecret("jarvis", { livekit_api_key: "k" });

  assert.equal(calls.length, 4);
  assert.equal(calls[3].token, "tok-2");
  assert.equal(calls[3].method, "POST");
});

test("k8s login failure falls back to the static token (safe rollout order)", async () => {
  const vault = await loadVault({
    ...K8S_ENV(jwtFile()),
    VAULT_TOKEN: "legacy-tok",
  });
  const calls = stubFetch([
    () => jsonResponse(400, { errors: ["role 'bionic-platform' not found"] }),
    () => kvOk(),
  ]);

  const secret = await vault.readAppSecret("jarvis");

  assert.equal(
    secret?.livekit_api_key,
    "key",
    "a missing Vault role must not take Vault reads down",
  );
  assert.match(calls[0].url, /\/auth\/kubernetes\/login$/);
  assert.equal(calls[1].token, "legacy-tok", "rides out on the legacy token");
});

test("k8s login failure with no static token still throws", async () => {
  const vault = await loadVault(K8S_ENV(jwtFile()));
  stubFetch([() => jsonResponse(400, { errors: ["role not found"] })]);

  const secret = await vault.readAppSecret("jarvis");
  assert.equal(secret, null, "no credential available — read fails, loudly");
});
