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

/** Replicates the guard added to ensureUserBlock in agentRouter.ts. */
function guardEnsureUserBlock(
  user: { sub: string; role: "admin" | "user" },
  input: { userId: string },
): void {
  if (user.role !== "admin" && input.userId !== user.sub) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "userId must match the caller's sub (or admin role required)",
    });
  }
}

test("ensureUserBlock: non-admin caller passing own sub → allowed", () => {
  assert.doesNotThrow(() =>
    guardEnsureUserBlock(
      { sub: "kc-sub-self", role: "user" },
      { userId: "kc-sub-self" },
    ),
  );
});

test("ensureUserBlock: non-admin caller passing another user's sub → FORBIDDEN", () => {
  assert.throws(
    () =>
      guardEnsureUserBlock(
        { sub: "kc-sub-attacker", role: "user" },
        { userId: "kc-sub-victim" },
      ),
    (err: unknown) =>
      err instanceof TRPCError &&
      err.code === "FORBIDDEN" &&
      /userId must match/.test(err.message),
  );
});

test("ensureUserBlock: admin passing another user's sub → allowed (legitimate pre-create path)", () => {
  assert.doesNotThrow(() =>
    guardEnsureUserBlock(
      { sub: "kc-sub-admin", role: "admin" },
      { userId: "kc-sub-anyone" },
    ),
  );
});

test("ensureUserBlock: admin passing own sub → allowed", () => {
  assert.doesNotThrow(() =>
    guardEnsureUserBlock(
      { sub: "kc-sub-admin", role: "admin" },
      { userId: "kc-sub-admin" },
    ),
  );
});
