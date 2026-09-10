/**
 * The one place that decides what DOM capabilities an embed token may carry.
 *
 * Kept out of embedRouter.ts so the public, unauthenticated embed route can
 * apply the same policy without importing the admin tRPC router (and the
 * whole procedure/auth graph behind it) to get at one pure function.
 *
 * The widget enforces all of this again at runtime -- this is the cheaper,
 * earlier copy, so an impossible token cannot be stored in the first place
 * and then puzzle someone later.
 *
 * - iframe embeds are a separate document from the host page and can reach
 *   nothing through it, so neither capability means anything there.
 * - control requires read: every action names a ref from the current listing.
 * - control requires an explicit origin allowlist. A token with no allowlist
 *   runs anywhere it is pasted, and "anywhere" is not somewhere to hand a
 *   click-and-type capability.
 */
export function domCapabilities(input: {
  mode: string;
  allowedOrigins: string[] | null | undefined;
  allowDomRead?: boolean;
  allowDomControl?: boolean;
}): { allowDomRead: boolean; allowDomControl: boolean } {
  if (input.mode !== "popup") return { allowDomRead: false, allowDomControl: false };
  const allowDomRead = input.allowDomRead ?? false;
  const allowDomControl =
    (input.allowDomControl ?? false) && allowDomRead && (input.allowedOrigins?.length ?? 0) > 0;
  return { allowDomRead, allowDomControl };
}
