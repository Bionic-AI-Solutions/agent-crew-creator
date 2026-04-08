/**
 * Unit tests for assertAppMembership.
 *
 * Run with: npx tsx --test tests/app-membership.test.ts
 *
 * Uses node:test (no new deps). Mocks ctx.db with a fake Drizzle query
 * builder so we can exercise admin bypass, member allow, non-member deny,
 * owner-required, and missing-db paths without a real PostgreSQL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TRPCError } from "@trpc/server";
import { assertAppMembership } from "../server/_core/trpc.js";

type FakeMembership = { appId: number; userId: string; role: "owner" | "member" };

function makeCtx(opts: {
  user: { sub: string; role: "admin" | "user" } | null;
  memberships?: FakeMembership[];
  withoutDb?: boolean;
}) {
  const memberships = opts.memberships ?? [];
  // Drizzle chain: select(...).from(table).where(condition).limit(n) → Promise<rows>
  // We don't try to interpret the condition — we just match against the userId
  // and appId captured from the most recent call. For this we sniff via a
  // closure: the helper calls select({ role: ... }).from(appMembers).where(and(eq(appId), eq(userId))).limit(1)
  // We capture appId+userId from the last assertAppMembership call via globals set by the helper... too brittle.
  //
  // Simpler: have where() store the predicate, and limit() filters memberships
  // by re-running a callback. But our helper passes opaque drizzle expressions.
  //
  // Pragmatic approach: monkey-patch the chain to ignore the predicate and
  // return ALL provided memberships (the test seeds only the rows that should
  // match). For the "non-member" case, seed [].
  const fakeDb = {
    select: (_cols?: unknown) => ({
      from: (_t: unknown) => ({
        where: (_w: unknown) => ({
          limit: async (_n: number) => memberships.map((m) => ({ role: m.role })),
        }),
      }),
    }),
  };
  return {
    user: opts.user,
    db: opts.withoutDb ? null : (fakeDb as any),
    req: {} as any,
    res: {} as any,
  };
}

test("assertAppMembership: admin bypasses without DB hit", async () => {
  const ctx = makeCtx({ user: { sub: "admin-sub", role: "admin" }, withoutDb: true });
  await assert.doesNotReject(() => assertAppMembership(ctx as any, 1));
});

test("assertAppMembership: unauthenticated → UNAUTHORIZED", async () => {
  const ctx = makeCtx({ user: null });
  await assert.rejects(
    () => assertAppMembership(ctx as any, 1),
    (err: unknown) => err instanceof TRPCError && err.code === "UNAUTHORIZED",
  );
});

test("assertAppMembership: member → allow", async () => {
  const ctx = makeCtx({
    user: { sub: "user-1", role: "user" },
    memberships: [{ appId: 1, userId: "user-1", role: "member" }],
  });
  await assert.doesNotReject(() => assertAppMembership(ctx as any, 1));
});

test("assertAppMembership: non-member → FORBIDDEN", async () => {
  const ctx = makeCtx({
    user: { sub: "user-2", role: "user" },
    memberships: [],
  });
  await assert.rejects(
    () => assertAppMembership(ctx as any, 1),
    (err: unknown) =>
      err instanceof TRPCError &&
      err.code === "FORBIDDEN" &&
      err.message === "Not a member of this app",
  );
});

test("assertAppMembership: requireOwner with member role → FORBIDDEN", async () => {
  const ctx = makeCtx({
    user: { sub: "user-1", role: "user" },
    memberships: [{ appId: 1, userId: "user-1", role: "member" }],
  });
  await assert.rejects(
    () => assertAppMembership(ctx as any, 1, { requireOwner: true }),
    (err: unknown) =>
      err instanceof TRPCError &&
      err.code === "FORBIDDEN" &&
      err.message === "App owner role required",
  );
});

test("assertAppMembership: requireOwner with owner role → allow", async () => {
  const ctx = makeCtx({
    user: { sub: "user-1", role: "user" },
    memberships: [{ appId: 1, userId: "user-1", role: "owner" }],
  });
  await assert.doesNotReject(() =>
    assertAppMembership(ctx as any, 1, { requireOwner: true }),
  );
});

test("assertAppMembership: non-admin user with no DB → INTERNAL_SERVER_ERROR", async () => {
  const ctx = makeCtx({ user: { sub: "user-1", role: "user" }, withoutDb: true });
  await assert.rejects(
    () => assertAppMembership(ctx as any, 1),
    (err: unknown) =>
      err instanceof TRPCError && err.code === "INTERNAL_SERVER_ERROR",
  );
});
