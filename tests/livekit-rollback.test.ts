/**
 * Regression tests for finding #4 (critical): a failed provisioning job's
 * LiveKit rollback only edited the live K8s Secret (a path the code itself
 * marks @deprecated because ESO reverts it), leaving the Vault entry and ESO
 * template line in place — so ESO resurrected the "deleted" key on its next
 * reconcile. The fix routes both the rollback and the app-deletion job through
 * one deregisterAppLivekitKey that removes the Vault key + strips the ESO
 * template, then edits the Secret.
 *
 * Run: npx tsx --test tests/livekit-rollback.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripLivekitEsoEntries,
  deregisterAppLivekitKey,
  type LivekitDeregisterDeps,
} from "../server/services/livekitDeregister.ts";

test("stripLivekitEsoEntries removes only the target slug's data refs and template lines", () => {
  const eso = {
    spec: {
      data: [
        { secretKey: "acme_api_key" },
        { secretKey: "acme_api_secret" },
        { secretKey: "other_api_key" },
      ],
      target: { template: { data: { LIVEKIT_KEYS: "acme: acmesecret\nother: othersecret" } } },
    },
  };
  stripLivekitEsoEntries(eso, "acme");
  assert.deepEqual(
    eso.spec.data.map((d) => d.secretKey),
    ["other_api_key"],
  );
  assert.equal(eso.spec.target.template.data.LIVEKIT_KEYS, "other: othersecret");
});

test("deregisterAppLivekitKey removes the Vault key, strips the ESO, and edits the Secret", async () => {
  const calls: Record<string, unknown[]> = {
    write: [],
    putEso: [],
    removeSecret: [],
    restart: [],
  };
  const vaultStore: Record<string, any> = {
    acme_api_key: "k",
    acme_api_secret: "s",
    other_api_key: "k2",
    other_api_secret: "s2",
  };
  const eso = {
    spec: {
      data: [{ secretKey: "acme_api_key" }, { secretKey: "other_api_key" }],
      target: { template: { data: { LIVEKIT_KEYS: "acme: x\nother: y" } } },
    },
  };
  const deps: LivekitDeregisterDeps = {
    readPlatformVaultPath: async () => ({ ...vaultStore }),
    writePlatformVaultPath: async (_p, data) => { calls.write.push(data); },
    getEso: async () => eso,
    putEso: async (e) => { calls.putEso.push(e); },
    removeK8sSecretKey: async (k) => { calls.removeSecret.push(k); },
    restartLivekit: async () => { calls.restart.push(true); },
  };

  await deregisterAppLivekitKey("acme", "livekit-api-key-value", deps);

  // Vault: the app's fields are gone, others remain.
  const written = calls.write[0] as Record<string, any>;
  assert.equal("acme_api_key" in written, false);
  assert.equal("acme_api_secret" in written, false);
  assert.equal(written.other_api_key, "k2");
  // ESO stripped + PUT back.
  assert.equal(calls.putEso.length, 1);
  assert.deepEqual(eso.spec.data.map((d) => d.secretKey), ["other_api_key"]);
  // Secret edited + server restarted.
  assert.deepEqual(calls.removeSecret, ["livekit-api-key-value"]);
  assert.equal(calls.restart.length, 1);
});

test("deregisterAppLivekitKey still strips Vault/ESO even when no live API key is passed", async () => {
  const calls = { write: 0, putEso: 0, removeSecret: 0 };
  const deps: LivekitDeregisterDeps = {
    readPlatformVaultPath: async () => ({ acme_api_key: "k", acme_api_secret: "s" }),
    writePlatformVaultPath: async () => { calls.write++; },
    getEso: async () => ({ spec: { data: [], target: { template: { data: { LIVEKIT_KEYS: "" } } } } }),
    putEso: async () => { calls.putEso++; },
    removeK8sSecretKey: async () => { calls.removeSecret++; },
    restartLivekit: async () => {},
  };
  await deregisterAppLivekitKey("acme", undefined, deps);
  assert.equal(calls.write, 1);
  assert.equal(calls.putEso, 1);
  assert.equal(calls.removeSecret, 0, "no Secret edit without a live key");
});
