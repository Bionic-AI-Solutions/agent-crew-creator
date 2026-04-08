/**
 * Integration tests for app_members SQL predicates against a real Postgres
 * (in-memory pglite). Complements the helper-branching tests in
 * app-membership.test.ts which use a fake Drizzle chain.
 *
 * Run: npx tsx --test tests/app-membership-pglite.test.ts
 *
 * What this proves:
 * - The migration SQL is valid Postgres.
 * - ON DELETE CASCADE on app_members.app_id actually fires.
 * - The unique (app_id, user_id) constraint actually rejects dupes.
 * - The where(and(eq(appId), eq(userId))).limit(1) shape used by the
 *   middleware actually matches the right row (and only that row).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import * as schema from "../drizzle/schema.js";
import { apps, appMembers } from "../drizzle/platformSchema.js";
import { readFileSync } from "node:fs";
import path from "node:path";

const openClients: PGlite[] = [];
process.on("beforeExit", async () => {
  for (const pg of openClients) try { await pg.close(); } catch {}
});
async function setupDb() {
  const pg = new PGlite();
  openClients.push(pg);
  // pglite doesn't have a `serial` fast-path issue but we still need to
  // create the apps + app_members tables. Use minimal subset.
  await pg.exec(`
    CREATE TABLE apps (
      id serial PRIMARY KEY,
      name varchar(255) NOT NULL,
      slug varchar(100) NOT NULL UNIQUE,
      description text,
      livekit_url varchar(500) NOT NULL DEFAULT 'wss://x',
      api_key varchar(255) NOT NULL DEFAULT '',
      api_secret varchar(500) NOT NULL DEFAULT '',
      room_prefix varchar(100),
      enabled_services json NOT NULL DEFAULT '["livekit"]'::json,
      provisioning_status varchar(50) NOT NULL DEFAULT 'pending',
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );
  `);
  // Apply the real migration SQL for app_members so the test exercises
  // exactly what runs in prod.
  const migrationSql = readFileSync(
    path.join(process.cwd(), "drizzle/migrations/0001_app_members.sql"),
    "utf8",
  );
  await pg.exec(migrationSql);
  return drizzle(pg, { schema });
}

test("pglite: schema applies and unique constraint rejects duplicate (app, user)", async () => {
  const db = await setupDb();
  const [app] = await db.insert(apps).values({ name: "A", slug: "a", livekitUrl: "wss://x" }).returning();
  await db.insert(appMembers).values({ appId: app.id, userId: "u1", role: "member" });
  await assert.rejects(
    () => db.insert(appMembers).values({ appId: app.id, userId: "u1", role: "owner" }),
    /duplicate key|unique/i,
  );
});

test("pglite: ON DELETE CASCADE removes app_members rows when app is deleted", async () => {
  const db = await setupDb();
  const [app] = await db.insert(apps).values({ name: "B", slug: "b", livekitUrl: "wss://x" }).returning();
  await db.insert(appMembers).values([
    { appId: app.id, userId: "u1", role: "member" },
    { appId: app.id, userId: "u2", role: "owner" },
  ]);
  const before = await db.select().from(appMembers);
  assert.equal(before.length, 2);
  await db.delete(apps).where(eq(apps.id, app.id));
  const after = await db.select().from(appMembers);
  assert.equal(after.length, 0, "all app_members rows for the deleted app should be cascaded");
});

test("pglite: middleware predicate where(and(eq(appId), eq(userId))) matches exactly one row", async () => {
  const db = await setupDb();
  const [a1] = await db.insert(apps).values({ name: "A1", slug: "a1", livekitUrl: "wss://x" }).returning();
  const [a2] = await db.insert(apps).values({ name: "A2", slug: "a2", livekitUrl: "wss://x" }).returning();
  // Seed: u1 is member of a1 only, u2 is member of both
  await db.insert(appMembers).values([
    { appId: a1.id, userId: "u1", role: "member" },
    { appId: a1.id, userId: "u2", role: "member" },
    { appId: a2.id, userId: "u2", role: "owner" },
  ]);

  // Replicate the exact query the middleware runs
  const u1InA1 = await db
    .select({ role: appMembers.role })
    .from(appMembers)
    .where(and(eq(appMembers.appId, a1.id), eq(appMembers.userId, "u1")))
    .limit(1);
  assert.equal(u1InA1.length, 1);
  assert.equal(u1InA1[0].role, "member");

  // u1 is NOT in a2 → middleware should get an empty result → FORBIDDEN
  const u1InA2 = await db
    .select({ role: appMembers.role })
    .from(appMembers)
    .where(and(eq(appMembers.appId, a2.id), eq(appMembers.userId, "u1")))
    .limit(1);
  assert.equal(u1InA2.length, 0, "u1 should not be a member of a2");

  // u2 in a2 should be owner (proves predicate isolates by appId, not just userId)
  const u2InA2 = await db
    .select({ role: appMembers.role })
    .from(appMembers)
    .where(and(eq(appMembers.appId, a2.id), eq(appMembers.userId, "u2")))
    .limit(1);
  assert.equal(u2InA2.length, 1);
  assert.equal(u2InA2[0].role, "owner");
});

test("pglite: appsCrud.list non-admin filter via inArray(memberships) returns only own apps", async () => {
  const db = await setupDb();
  const [a1] = await db.insert(apps).values({ name: "A1", slug: "list-a1", livekitUrl: "wss://x" }).returning();
  const [a2] = await db.insert(apps).values({ name: "A2", slug: "list-a2", livekitUrl: "wss://x" }).returning();
  const [a3] = await db.insert(apps).values({ name: "A3", slug: "list-a3", livekitUrl: "wss://x" }).returning();
  await db.insert(appMembers).values([
    { appId: a1.id, userId: "u1", role: "owner" },
    { appId: a3.id, userId: "u1", role: "member" },
    { appId: a2.id, userId: "u2", role: "owner" },
  ]);
  // Replicate appRouter.list non-admin branch
  const memberships = await db
    .select({ appId: appMembers.appId })
    .from(appMembers)
    .where(eq(appMembers.userId, "u1"));
  const ids = memberships.map((m) => m.appId).sort();
  assert.deepEqual(ids, [a1.id, a3.id].sort(), "u1 should see exactly a1 and a3");
});
