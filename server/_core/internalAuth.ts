/**
 * Shared internal-token gate for endpoints that are only ever called by
 * trusted in-cluster pods (agent pods, player-ui pods, Letta tool sandbox).
 *
 * Accepts either PLAYER_UI_INTERNAL_TOKEN or AGENT_INTERNAL_TOKEN, presented in
 * the `X-Internal-Token` header. Fails closed in production when neither token
 * is configured; allows through in development for local testing (mirrors the
 * long-standing behavior in playerUiApi.ts).
 */

export interface HeaderReader {
  header(name: string): string | undefined;
}

export function verifyInternalToken(req: HeaderReader): boolean {
  const playerToken = process.env.PLAYER_UI_INTERNAL_TOKEN;
  const agentToken = process.env.AGENT_INTERNAL_TOKEN;
  const got = req.header("X-Internal-Token") || "";

  if (playerToken || agentToken) {
    return got === playerToken || got === agentToken;
  }
  // No token configured: reject in production, allow in dev.
  return process.env.NODE_ENV !== "production";
}
