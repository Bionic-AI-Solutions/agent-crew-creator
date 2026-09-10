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
 * removing the element. Enumerating them is a losing game -- and this file
 * spent three review rounds proving it, swinging between missing real
 * overlays and revoking on ordinary pages as a hand-written scan tried to
 * work out what paints on top of what.
 *
 * It is split in two now, along the line of what can actually be answered:
 *
 * 1. Everything measurable about the bar ITSELF -- is it on screen, big
 *    enough, opaque, unfiltered, unmasked, unclipped, and the thing the
 *    user's cursor would land on. Cheap, synchronous, and correct in every
 *    browser.
 *
 * 2. "Is something painted over me", which needs paint order, stacking
 *    contexts and the top layer, and which no reasonable amount of
 *    in-page arithmetic gets right. The browser already computes it:
 *    IntersectionObserver v2's `isVisible` exists to tell content whether it
 *    is being covered -- it is the clickjacking-protection primitive, and
 *    this is that question. The caller supplies its answer as `occluded`.
 *
 * The observer answers a paint-order question: `isVisible` goes false when
 * anything composites above the bar, opaque or not. That made it useless as a
 * verdict on an ordinary element -- a `position: fixed; inset: 0;
 * pointer-events: none` portal root, which every third-party chat and consent
 * widget mounts, sets it while the bar renders pixel-for-pixel unchanged.
 *
 * In the top layer it becomes exact, because the set of things that can be
 * above a top-layer element is just "other top-layer elements". Nothing else
 * in the page can be, so a "covered" that survives re-assertion means a real
 * modal or popover is over the Stop button, and taking control away is right.
 *
 * Fails closed on its own checks: if one cannot be performed, the answer is
 * "not visible". It does NOT fail closed on the observer, which is the one
 * place a missing answer means "we do not know" rather than "we are hidden" --
 * see the note on controlUiVisibility.
 *
 * The scrim inside a CLOSED shadow root, which an earlier version of this
 * file documented as a permanent limit on the grounds that nothing can
 * traverse a closed root: it is not a limit any more. Nothing needs to
 * traverse it, because it cannot paint over the top layer in the first place.
 * Verified in Chromium, along with the SVG fill, the pseudo-element and the
 * decoy-flood that defeated the probe.
 *
 * WHAT THIS DOES NOT DO, stated plainly because the docstring used to claim
 * more than the code delivered:
 *
 * IntersectionObserver v2 is Chromium-only today. Where it is absent --
 * Firefox, Safari -- part 2 is simply unavailable, and a `pointer-events:
 * none` scrim over the bar will not be detected. Part 1 still runs, so
 * everything that hides the bar by styling it is still caught everywhere.
 * Detecting that absence needs care: those browsers ship v1, and WebIDL says
 * an unknown dictionary member is ignored, so `{ trackVisibility: true }`
 * constructs there without throwing and every entry simply lacks `isVisible`.
 * Reading `!entry.isVisible` off such an entry yields `true` -- "covered" --
 * on a pristine page. See supportsVisibilityObserver in usePageActions.ts.
 *
 * That residual gap is bounded by who the host page belongs to. Control only
 * runs on origins the token owner explicitly allowlisted (see
 * domCapabilities), so the page doing the hiding is the operator's own -- and
 * an operator who can run script on their own site can already click every
 * button on it without involving an agent.
 *
 * What these checks are really for is the case that is both likely and
 * genuinely harmful: a bar hidden BY ACCIDENT -- a CSS reset, an id
 * collision, a loading backdrop, a modal scrim -- while the agent keeps
 * acting and the user has no way to stop it.
 */

/** Smaller than this and the bar is not something a user can find or press. */
const MIN_WIDTH = 40;
const MIN_HEIGHT = 16;

/** Below this, the bar is not legible enough to count as shown. */
const MIN_OPACITY = 0.5;

/** How far up the ancestor chain to walk before giving up. */
const MAX_ANCESTOR_DEPTH = 100;

/**
 * Where the bar actually is.
 *
 * "unsupported" is a browser without the popover API -- a fact of life, and
 * the ancestor checks fall back to covering what the top layer would have.
 * "failed" is a browser that HAS it where we could not get there anyway,
 * which means something is interfering and is not a state to carry on in.
 */
export type TopLayerState = "top-layer" | "unsupported" | "failed";

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
    backgroundImage?: string;
    backdropFilter?: string;
    maskImage?: string;
    webkitMaskImage?: string;
    webkitMaskBoxImage?: string;
    clipPath?: string;
    contentVisibility?: string;
    zIndex?: string;
  };
  document: {
    elementFromPoint(x: number, y: number): Element | null;
    querySelectorAll?(selector: string): ArrayLike<Element>;
  };
}

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

/**
 * Ancestor effects that hide a descendant and that a descendant cannot undo.
 *
 * The same class as `filter`: compositing and clipping properties that apply
 * to a whole subtree. `mask-image: linear-gradient(transparent,transparent)`,
 * `clip-path: inset(100%)` and `content-visibility: hidden` each render the
 * bar to zero pixels while leaving its own computed style, and in two of the
 * three cases its rect, completely unremarkable. The wrapper's inline reset
 * lists clip-path and content-visibility, so they were anticipated on the
 * element itself -- but never checked on the chain above it, where the reset
 * cannot reach.
 */
function hidingEffect(style: {
  maskImage?: string;
  webkitMaskImage?: string;
  webkitMaskBoxImage?: string;
  clipPath?: string;
  contentVisibility?: string;
}): string | null {
  for (const mask of [style.maskImage, style.webkitMaskImage, style.webkitMaskBoxImage]) {
    if (mask && mask !== "none" && mask !== "") return "masked";
  }
  const clip = style.clipPath ?? "none";
  if (clip !== "none" && clip !== "") return "clipped";
  if ((style.contentVisibility ?? "visible") === "hidden") return "not rendered";
  return null;
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
 * @param opts.occluded  the browser's own answer to "is something covering
 *   this", from IntersectionObserver v2. `null` when unknown or unsupported.
 *
 * This used to walk thousands of elements looking for a `pointer-events:none`
 * scrim, because hit testing skips those. Three rounds of review swung that
 * scan between missing real overlays and revoking on innocent pages -- a
 * background video, then a portal container, then a stacking context on the
 * wrapper -- which is what a heuristic for "what paints on top" looks like
 * when the real answer needs paint order, stacking contexts and the top
 * layer.
 *
 * The browser already computes that answer. IntersectionObserver v2's
 * `isVisible` exists to tell a frame whether it is being covered -- it is the
 * clickjacking-protection primitive, which is this exact question -- and it
 * agreed with rendered pixels in every case that defeated the scan, and in
 * every innocent case the scan wrongly revoked.
 *
 * It is deliberately conservative, though: an ancestor `filter` or a
 * translucent ancestor makes it answer "not visible" even when the bar is
 * perfectly legible (a `drop-shadow` on body, or the `filter: invert(1)` a
 * dark-mode userstyle applies). So its "no" is only acted on when nothing in
 * the ancestor chain could explain a conservative answer -- and those effects
 * are judged on their own terms just above, where `filter: opacity(0)` is
 * hidden and `drop-shadow` is not.
 */
export function controlUiVisibility(
  bar: Element | null | undefined,
  win: VisibilityWindow,
  opts: { occluded?: boolean | null; topLayer?: TopLayerState } = {},
): VisibilityVerdict {
  const topLayer = opts.topLayer ?? "unsupported";
  const inTopLayer = topLayer === "top-layer";
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
    // Only on the bar itself. visibility INHERITS, so an ancestor's "hidden"
    // already shows up in the bar's own computed value -- but it is also the
    // one property a descendant may legally re-enable, and the wrapper's
    // inline reset sets visibility:visible !important. Checking the chain
    // therefore revoked control on `body { visibility: hidden }`, a standard
    // anti-FOUC pattern, while the bar was rendering perfectly. Fail-closed,
    // but closed on a page doing nothing wrong.
    if (el === bar && (style.visibility === "hidden" || style.visibility === "collapse")) {
      return hidden("control_ui_hidden", "the control bar is hidden by the page (visibility)");
    }
    // The bar's own opacity always counts. An ancestor's counts only outside
    // the top layer -- verified in Chromium that `body { opacity: 0 }` and
    // `#wrapper { opacity: 0 }` both leave a top-layer bar rendering
    // untouched, so checking them there would revoke for nothing.
    if (el === bar || !inTopLayer) {
      const opacity = parseFloat(style.opacity);
      if (Number.isFinite(opacity) && opacity < MIN_OPACITY) {
        return hidden("control_ui_transparent", "the control bar has been made transparent");
      }
    }
    // Checked on the whole chain, including documentElement: a filter on an
    // ancestor is not visible on the element's own computed style and cannot
    // be undone from below.
    // An ancestor's compositing effects do not reach the top layer -- verified
    // in Chromium: with the bar shown as a popover, `html { filter:
    // opacity(0) }`, `body { opacity: 0 }`, `transform: scale(0)`, a
    // transparent mask and `clip-path: inset(100%)` all leave it rendering
    // untouched. Applying these checks there would revoke control on pages
    // doing nothing to us at all.
    //
    // What still reaches it is what zeroes its box or its inherited
    // visibility -- display:none, content-visibility:hidden,
    // visibility:hidden -- and those are caught above, by the size check and
    // by the bar's own computed style.
    if (!inTopLayer) {
      if (filterHides(style.filter)) {
        return hidden("control_ui_filtered", "the control bar has been filtered out of view");
      }
      const effect = hidingEffect(style);
      if (effect) {
        return hidden("control_ui_filtered", `the control bar is ${effect} by the page`);
      }
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
  // Only one thing can still be covering a top-layer bar: another top-layer
  // element opened after it. The observer sees that, and the caller has
  // already tried to re-assert -- so a claim that survives re-assertion is
  // real, and there is nothing left to corroborate it against.
  //
  // Where the top layer is unavailable the observer is not acted on at all.
  // Its "covered" is a paint-order answer that goes true for a fully
  // transparent portal root, and three rounds of trying to tell those apart
  // from real scrims -- by scanning, by stacking level, by probing what each
  // candidate paints -- were each defeated by something not modelled. Without
  // the top layer there is no sound way to act on it, so it is left alone.
  // Something is preventing the bar from reaching the top layer on a browser
  // that supports it. The page can cause exactly this by removing the popover
  // attribute, and the previous version treated it as "no top layer here" and
  // relaxed -- turning off the only check that sees a pointer-events:none
  // scrim. An anomaly is not a licence to check less.
  if (topLayer === "failed") {
    return hidden("control_ui_detached", "the control bar could not be kept in front");
  }

  if (inTopLayer && opts.occluded === true) {
    return hidden("control_ui_obscured", "something on the page is covering the control bar");
  }

  return VISIBLE;
}
