/**
 * Is the control bar -- and therefore the Stop button -- actually visible?
 *
 * Control mode rests on one promise: while an agent can press things on your
 * page, you can see that it can, and you can stop it. The widget mounts into
 * `<div id="bionic-embed-wrapper">`, which is an ordinary, predictably-named
 * element in the host page's own light DOM. Shadow DOM isolates our styles
 * from the page; it does nothing to stop the page styling the host element.
 * One rule -- `#bionic-embed-wrapper { display: none !important }` -- hid the
 * banner and Stop while every RPC method stayed registered and working. No
 * exploit, no XSS: an ordinary CSS reset or an ID collision does it by
 * accident.
 *
 * Hardening the styles alone cannot close this. A page has too many ways to
 * make something invisible: an ancestor's `opacity: 0`, a full-screen overlay
 * on top, `pointer-events: none`, moving it past the viewport edge, or simply
 * removing the element. Enumerating them is a losing game.
 *
 * So this does not enumerate attacks. It checks the property control actually
 * depends on -- this element is on screen, opaque, and the thing the user's
 * cursor would land on -- and the caller revokes control when it stops being
 * true. Anything that hides the bar by any means fails one of these checks,
 * including means nobody has thought of.
 *
 * Fails closed: if a check cannot be performed, the answer is "not visible".
 */

/** Smaller than this and the bar is not something a user can find or press. */
const MIN_WIDTH = 40;
const MIN_HEIGHT = 16;

/** Below this, the bar is not legible enough to count as shown. */
const MIN_OPACITY = 0.5;

/** How far up the ancestor chain to walk before giving up. */
const MAX_ANCESTOR_DEPTH = 100;

export interface VisibilityVerdict {
  visible: boolean;
  reason: string;
  detail: string;
}

const VISIBLE: VisibilityVerdict = { visible: true, reason: "", detail: "" };

function hidden(reason: string, detail: string): VisibilityVerdict {
  return { visible: false, reason, detail };
}

/** The minimal slice of `window` this needs, so tests can supply their own. */
export interface VisibilityWindow {
  innerWidth: number;
  innerHeight: number;
  getComputedStyle(el: Element): {
    display: string;
    visibility: string;
    opacity: string;
    pointerEvents: string;
  };
  document: {
    elementFromPoint(x: number, y: number): Element | null;
  };
}

/**
 * The outermost host: walk out of every shadow root the bar sits inside, to
 * the element the host page can actually see and style.
 *
 * That element, not the bar, is what `elementFromPoint` reports for a click
 * landing on our UI, because an open shadow root retargets the result to its
 * host.
 */
export function outermostHost(bar: Element): Element {
  let node: Element = bar;
  for (let i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
    const root = node.getRootNode?.() as ShadowRoot | Document | undefined;
    const host = (root as ShadowRoot | undefined)?.host;
    if (!host) return node;
    node = host;
  }
  return node;
}

/**
 * Every element between the bar and the document root, crossing out of shadow
 * roots on the way.
 *
 * Ancestors matter because the properties that hide something are not all
 * visible on the element itself. `opacity` does not inherit and does not
 * change the element's own computed style or its rect, so an ancestor set to
 * `opacity: 0` leaves the bar looking perfectly fine to a check that only
 * examines the bar.
 */
function ancestorChain(bar: Element): Element[] {
  const chain: Element[] = [];
  let node: Element | null = bar;
  for (let i = 0; i < MAX_ANCESTOR_DEPTH && node; i++) {
    chain.push(node);
    const parent: Element | null = node.parentElement;
    if (parent) {
      node = parent;
      continue;
    }
    const root = node.getRootNode?.() as ShadowRoot | Document | undefined;
    const host = (root as ShadowRoot | undefined)?.host ?? null;
    node = host;
  }
  return chain;
}

/**
 * Does a point land on our own UI?
 *
 * Catches the two cases the style checks cannot see: something else painted
 * on top, and `pointer-events` making the bar unclickable while it still
 * looks fine.
 */
function pointHitsUs(win: VisibilityWindow, host: Element, x: number, y: number): boolean {
  let hit: Element | null;
  try {
    hit = win.document.elementFromPoint(x, y);
  } catch {
    return false;
  }
  if (!hit) return false;
  // Compared through outermostHost rather than contains() alone, because
  // contains() does not cross a shadow boundary: a node from inside our own
  // shadow root is not "contained" by the wrapper that hosts it, and would
  // read as an overlay covering us. document.elementFromPoint retargets to
  // the host in practice, so this is belt-and-braces -- but the belt is
  // cheap, and the failure mode is revoking control for no reason.
  if (hit === host || outermostHost(hit) === host) return true;
  return host.contains(hit) || hit.contains(host);
}

/**
 * @param bar  the control bar element, inside the widget's shadow root
 * @param win  the host page's window
 */
export function controlUiVisibility(
  bar: Element | null | undefined,
  win: VisibilityWindow,
): VisibilityVerdict {
  if (!bar) return hidden("control_ui_missing", "the control bar is not mounted");
  if (!bar.isConnected) {
    return hidden("control_ui_detached", "the control bar was removed from the page");
  }

  let rect: { width: number; height: number; top: number; left: number; bottom: number; right: number };
  try {
    rect = bar.getBoundingClientRect();
  } catch {
    return hidden("control_ui_unmeasurable", "the control bar could not be measured");
  }

  if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) {
    return hidden(
      "control_ui_too_small",
      `the control bar is ${Math.round(rect.width)}x${Math.round(rect.height)}, too small to see or press`,
    );
  }

  // Wholly outside the viewport -- pushed off an edge rather than hidden.
  if (
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= win.innerHeight ||
    rect.left >= win.innerWidth
  ) {
    return hidden("control_ui_off_screen", "the control bar is outside the visible page");
  }

  for (const el of ancestorChain(bar)) {
    let style: ReturnType<VisibilityWindow["getComputedStyle"]>;
    try {
      style = win.getComputedStyle(el);
    } catch {
      return hidden("control_ui_unreadable", "the control bar's styling could not be read");
    }
    if (!style) return hidden("control_ui_unreadable", "the control bar's styling could not be read");

    if (style.display === "none") {
      return hidden("control_ui_hidden", "the control bar is hidden by the page (display)");
    }
    if (style.visibility === "hidden" || style.visibility === "collapse") {
      return hidden("control_ui_hidden", "the control bar is hidden by the page (visibility)");
    }
    const opacity = parseFloat(style.opacity);
    if (Number.isFinite(opacity) && opacity < MIN_OPACITY) {
      return hidden("control_ui_transparent", "the control bar has been made transparent");
    }
    // Only the bar itself needs to be clickable; `pointer-events: none` on an
    // ancestor is routinely re-enabled by a descendant, and the hit test
    // below is what actually settles reachability.
    if (el === bar && style.pointerEvents === "none") {
      return hidden("control_ui_unclickable", "the control bar cannot be clicked");
    }
  }

  // Finally, the question the style checks only approximate: if the user
  // reached for the bar, would they reach it? Sampled across its width, since
  // a narrow overlay could cover just the Stop button.
  const host = outermostHost(bar);
  const y = rect.top + rect.height / 2;
  const points: Array<[number, number]> = [
    [rect.left + rect.width * 0.15, y],
    [rect.left + rect.width * 0.5, y],
    [rect.left + rect.width * 0.85, y],
  ];
  const reachable = points.filter(
    ([x, py]) =>
      x >= 0 && x < win.innerWidth && py >= 0 && py < win.innerHeight && pointHitsUs(win, host, x, py),
  );
  if (reachable.length === 0) {
    return hidden("control_ui_obscured", "something on the page is covering the control bar");
  }

  return VISIBLE;
}
