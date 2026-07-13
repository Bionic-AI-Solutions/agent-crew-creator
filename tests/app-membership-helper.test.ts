/**
 * Regression tests for finding #5 (high): the document-upload endpoint required
 * a GLOBAL admin role, so ordinary app owners/members (the users who actually
 * build agents) could not upload RAG documents. The shared userIsAppMember
 * helper now gates on app membership, matching every other agent-scoped route.
 *
 * Run: npx tsx --test tests/app-membership-helper.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { userIsAppMember } from "../server/_core/appMembership.ts";

/** Minimal Drizzle-select stub returning a fixed row set. */
function stubDb(rows: unknown[]) {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => rows,
  };
  return chain as any;
}

test("global admin is always a member (no DB lookup needed)", async () => {
  const ok = await userIsAppMember(stubDb([]), 1, { sub: "u1", role: "admin" });
  assert.equal(ok, true);
});

test("app member (non-global-admin) is allowed", async () => {
  const ok = await userIsAppMember(stubDb([{ role: "owner" }]), 1, { sub: "u2", role: "user" });
  assert.equal(ok, true);
});

test("non-member is rejected", async () => {
  const ok = await userIsAppMember(stubDb([]), 1, { sub: "u3", role: "user" });
  assert.equal(ok, false);
});
