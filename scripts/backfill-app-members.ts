/**
 * One-time backfill: insert an `owner` app_members row for every existing app.
 *
 * Strategy: there is no creator column on `apps`, so this script seeds a single
 * configurable owner (BACKFILL_OWNER_SUB env var = Keycloak `sub`) as owner of
 * every existing app. Run once after the 0001_app_members migration. Admins
 * bypass membership at the procedure level, so this is mostly for analysts to
 * regain visibility into apps they should manage.
 *
 * Usage:
 *   BACKFILL_OWNER_SUB=<keycloak-sub> tsx scripts/backfill-app-members.ts
 */
import { getDb } from "../server/db.js";
import { apps, appMembers } from "../drizzle/platformSchema.js";
import { and, eq } from "drizzle-orm";

async function main() {
  const ownerSub = process.env.BACKFILL_OWNER_SUB;
  if (!ownerSub) {
    console.error("BACKFILL_OWNER_SUB env var is required (Keycloak sub claim)");
    process.exit(1);
  }
  const db = await getDb();
  if (!db) {
    console.error("No database connection");
    process.exit(1);
  }
  const allApps = await db.select({ id: apps.id, slug: apps.slug }).from(apps);
  let inserted = 0;
  for (const a of allApps) {
    const existing = await db
      .select({ id: appMembers.id })
      .from(appMembers)
      .where(and(eq(appMembers.appId, a.id), eq(appMembers.userId, ownerSub)))
      .limit(1);
    if (existing.length > 0) continue;
    await db.insert(appMembers).values({ appId: a.id, userId: ownerSub, role: "owner" });
    inserted++;
    console.log(`seeded owner for app ${a.slug} (${a.id})`);
  }
  console.log(`done: ${inserted} rows inserted, ${allApps.length - inserted} skipped`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
