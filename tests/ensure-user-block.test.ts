/**
 * Regression test for the ensureUserBlock horizontal-privilege bug.
 *
 * Adversarial review observation: ensureUserBlock was an appScopedProcedure
 * that took {appId, agentConfigId, userId, blockLabel} as input but only
 * gated on appId membership. Any same-app member could pass another user's
 * Keycloak sub as userId and create / attach a Letta memory block under
 * that identity.
 *
 * Fix: bind input.userId === ctx.user.sub for non-admins. This test
 * exercises the contract directly without spinning up a tRPC server, by
 * replicating the exact guard the procedure now applies.
 *
 * Run: npx tsx --test tests/ensure-user-block.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TRPCError } from "@trpc/server";
// Import the REAL guard used by ensureUserBlock — not a reimplementation — so a
// regression in the actual code path fails this test (finding #25).
import { assertUserIdMatchesCaller } from "../server/_core/userBlockGuard.ts";

test("ensureUserBlock: non-admin caller passing own sub → allowed", () => {
  assert.doesNotThrow(() =>
    assertUserIdMatchesCaller({ sub: "kc-sub-self", role: "user" }, "kc-sub-self"),
  );
});

test("ensureUserBlock: non-admin caller passing another user's sub → FORBIDDEN", () => {
  assert.throws(
    () => assertUserIdMatchesCaller({ sub: "kc-sub-attacker", role: "user" }, "kc-sub-victim"),
    (err: unknown) =>
      err instanceof TRPCError &&
      err.code === "FORBIDDEN" &&
      /userId must match/.test(err.message),
  );
});

test("ensureUserBlock: admin passing another user's sub → allowed (legitimate pre-create path)", () => {
  assert.doesNotThrow(() =>
    assertUserIdMatchesCaller({ sub: "kc-sub-admin", role: "admin" }, "kc-sub-anyone"),
  );
});

test("ensureUserBlock: admin passing own sub → allowed", () => {
  assert.doesNotThrow(() =>
    assertUserIdMatchesCaller({ sub: "kc-sub-admin", role: "admin" }, "kc-sub-admin"),
  );
});
