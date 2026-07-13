import { TRPCError } from "@trpc/server";

/**
 * Bind a caller-supplied userId to the caller's own Keycloak sub (admins
 * exempt). Without this, any same-app member could pass another user's sub and
 * create/attach a Letta memory block under that identity — horizontal privilege
 * escalation within the app. Shared between the ensureUserBlock procedure and
 * its regression test so the test exercises the REAL guard, not a copy.
 */
export function assertUserIdMatchesCaller(
  user: { sub: string; role: string },
  userId: string,
): void {
  if (user.role !== "admin" && userId !== user.sub) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "userId must match the caller's sub (or admin role required)",
    });
  }
}
