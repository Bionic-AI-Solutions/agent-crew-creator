/**
 * Shared app-membership check used by both the tRPC assertAppMembership guard
 * and plain Express routes (e.g. the document-upload endpoint). Global admins
 * bypass; everyone else must have an app_members row for the app.
 */

export interface MembershipUser {
  sub: string;
  role: string;
}

export interface MembershipDb {
  select: (...args: any[]) => any;
}

export async function userIsAppMember(
  db: MembershipDb,
  appId: number,
  user: MembershipUser,
): Promise<boolean> {
  if (user.role === "admin") return true;
  const { appMembers } = await import("../../drizzle/platformSchema.js");
  const { and, eq } = await import("drizzle-orm");
  const rows = await db
    .select({ role: appMembers.role })
    .from(appMembers)
    .where(and(eq(appMembers.appId, appId), eq(appMembers.userId, user.sub)))
    .limit(1);
  return rows.length > 0;
}
