/**
 * Origin allowlist check for embed tokens.
 *
 * Finding #16: the previous inline check only enforced the allowlist when an
 * Origin header was present (`&& origin`), so any non-browser client (curl, a
 * server script) could omit Origin and bypass the restriction entirely. A
 * restricted token must REQUIRE a matching Origin.
 */
export function isEmbedOriginAllowed(
  allowedOrigins: string[] | null | undefined,
  origin: string | undefined,
): boolean {
  // No allowlist configured → token is unrestricted by origin.
  if (!allowedOrigins || allowedOrigins.length === 0) return true;
  // Allowlist configured → a matching Origin is mandatory (absent = reject).
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}
