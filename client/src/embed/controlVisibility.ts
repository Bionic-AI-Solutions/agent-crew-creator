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
 * So this checks the property control actually depends on -- this element is
 * on screen, opaque, unfiltered, and the thing the user's cursor would land
 * on -- and the caller revokes control when it stops being true.
 *
 * Fails closed: if a check cannot be performed, the answer is "not visible".
 *
 * WHAT THIS DOES NOT DO, stated plainly because the docstring used to claim
 * more than the code delivers:
 *
 * This is not proof against a host page that is actively trying to defeat it.
 * The page owns the document; it can restyle, cover or remove anything in it,
 * and short of sampling pixels -- which a page cannot do to itself -- no
 * in-page check can be exhaustive. Two rounds of review found two ways past
 * an earlier version of this file (an ancestor `filter`, and an opaque
 * `pointer-events: none` layer that hit testing skips); both are closed
 * below, and the honest expectation is that a third exists.
 *
 * That is a bounded problem rather than an open one, because of who the host
 * page belongs to. Control only runs on origins the token owner explicitly
 * allowlisted (see domCapabilities), so the page doing the hiding is the
 * operator's own -- and an operator who can run script on their own site can
 * already click every button on it without involving an agent. Defeating this
 * check gains such a page nothing it did not already have.
 *
 * What these checks are really for is the case that is both likely and
 * genuinely harmful: a bar hidden BY ACCIDENT -- a CSS reset, an id
 * collision, a loading backdrop, a modal scrim -- while the agent keeps
 * acting and the user has no way to stop it. That is the failure this
 * prevents, and it prevents it well.
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
    filter?: string;
    position?: string;
    backgroundColor?: string;
    backdropFilter?: string;
  };
  document: {
    elementFromPoint(x: number, y: number): Element | null;
    querySelectorAll?(selector: string): ArrayLike<Element>;
  };
}

/** How many elements the overlay scan will look at before giving up. */
const MAX_OVERLAY_SCAN = 4000;

/**
 * Does this `filter` value hide what it is applied to?
 *
 * `filter` is the gap that a per-element style check cannot see and the
 * wrapper's own inline reset cannot close: it is a compositing effect that
 * does not inherit, and no descendant can undo an ancestor's. One line --
 * `html { filter: opacity(0) }`, which does not even name the widget --
 * renders the entire page blank while every element's own computed filter
 * stays "none" and every rect is unchanged. Confirmed in Chromium.
 *
 * Only the filters that actually hide count. Rejecting every non-"none"
 * filter would revoke control on the many pages that put a drop-shadow or a
 * dark-mode invert on a container, which is a broken feature, not a safe one.
 */
export function filterHides(value: string | undefined): boolean {
  if (!value || value === "none") return false;
  const lowered = value.toLowerCase();
  for (const [fn, limit] of [
    ["opacity", MIN_OPACITY],
    ["brightness", 0.3],
  ] as const) {
    const m = new RegExp(`${fn}\\(\\s*([0-9.]+)(%?)\\s*\\)`).exec(lowered);
    if (m) {
      const raw = parseFloat(m[1]);
      if (Number.isFinite(raw)) {
        const scaled = m[2] === "%" ? raw / 100 : raw;
        if (scaled < limit) return true;
      }
    }
  }
  // Enough blur and the text is not readable, whatever the opacity says.
  const blur = /blur\(\s*([0-9.]+)px\s*\)/.exec(lowered);
  if (blur && parseFloat(blur[1]) >= 8) return true;
  return false;
}

/** A colour that paints over what is behind it. */
function isOpaquePaint(colour: string | undefined): boolean {
  if (!colour) return false;
  const m = /rgba?\(([^)]+)\)/.exec(colour);
  if (!m) return colour !== "transparent";
  const parts = m[1].split(",").map((p) => parseFloat(p));
  const alpha = parts.length >= 4 ? parts[3] : 1;
  return Number.isFinite(alpha) && alpha > 0.3;
}

/**
 * Something painted over the bar that hit testing cannot see.
 *
 * `document.elementFromPoint` -- and `elementsFromPoint` too, confirmed in
 * Chromium -- skips anything with `pointer-events: none`. So an opaque
 * `pointer-events: none` layer over the bar reports a clean hit on the bar
 * underneath it while a person sees only the layer. That is not an exotic
 * attack: fade transitions, scroll-lock shims and loading backdrops are all
 * built exactly like that, and when one covers the bar the user genuinely
 * cannot press Stop.
 *
 * There is no cheap exact answer -- the page cannot be screenshotted from
 * inside itself -- so this is a bounded, deliberately conservative scan:
 * positioned elements that cover the sample point, are opaque, and are not
 * part of our own tree. Ancestors are excluded because body and html legally
 * have backgrounds and sit behind us, not over us.
 */
function opaqueOverlayAt(
  win: VisibilityWindow,
  host: Element,
  bar: Element,
  x: number,
  y: number,
): boolean {
  const all = win.document.querySelectorAll?.("*");
  if (!all) return false;
  const limit = Math.min(all.length, MAX_OVERLAY_SCAN);
  for (let i = 0; i < limit; i++) {
    const el = all[i];
    if (el === host || el === bar) continue;
    // Ours, or something we sit inside: not painted over us.
    if (el.contains?.(host) || host.contains?.(el)) continue;

    let rect: DOMRect;
    try {
      rect = el.getBoundingClientRect();
    } catch {
      continue;
    }
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;

    let style: ReturnType<VisibilityWindow["getComputedStyle"]>;
    try {
      style = win.getComputedStyle(el);
    } catch {
      continue;
    }
    // Anything that accepts pointer events would have been reported by the
    // hit test already; this scan exists only for what the hit test skips.
    if (style.pointerEvents !== "none") continue;
    if (style.display === "none" || style.visibility === "hidden") continue;
    const position = style.position ?? "static";
    if (position !== "fixed" && position !== "absolute" && position !== "sticky") continue;
    const opacity = parseFloat(style.opacity);
    if (Number.isFinite(opacity) && opacity < 0.3) continue;
    if (isOpaquePaint(style.backgroundColor) || (style.backdropFilter ?? "none") !== "none") {
      return true;
    }
  }
  return false;
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
    // Checked on the whole chain, including documentElement: a filter on an
    // ancestor is not visible on the element's own computed style and cannot
    // be undone from below.
    if (filterHides(style.filter)) {
      return hidden("control_ui_filtered", "the control bar has been filtered out of view");
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
  const onScreen = points.filter(
    ([x, py]) => x >= 0 && x < win.innerWidth && py >= 0 && py < win.innerHeight,
  );
  const reachable = onScreen.filter(([x, py]) => pointHitsUs(win, host, x, py));
  if (reachable.length === 0) {
    return hidden("control_ui_obscured", "something on the page is covering the control bar");
  }

  // The hit test above cannot see a `pointer-events: none` layer, so every
  // point it called reachable is checked again for one.
  for (const [x, py] of reachable) {
    if (opaqueOverlayAt(win, host, bar, x, py)) {
      return hidden("control_ui_obscured", "something on the page is covering the control bar");
    }
  }

  return VISIBLE;
}
