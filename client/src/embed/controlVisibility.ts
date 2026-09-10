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
 * The observer is a TRIGGER, not a verdict. `isVisible` is a paint-order
 * answer: it goes false when anything composites above the bar, opaque or
 * not. A `position: fixed; inset: 0; pointer-events: none` portal root with
 * no background -- what every third-party chat, consent and analytics widget
 * mounts -- makes it say "covered" while the bar renders pixel-for-pixel
 * unchanged. So a claim of covered is corroborated by opaqueCoverAt before
 * control is taken away.
 *
 * Fails closed on its own checks: if one cannot be performed, the answer is
 * "not visible". It does NOT fail closed on the observer, which is the one
 * place a missing answer means "we do not know" rather than "we are hidden" --
 * see the note on controlUiVisibility.
 *
 * THE KNOWN LIMIT, named rather than implied: an opaque scrim inside a CLOSED
 * shadow root. The observer notices it, but nothing can traverse a closed
 * root to corroborate -- that is what closed means -- so it is allowed
 * through. This is a deliberate trade, not an oversight: the alternative is
 * acting on the observer alone, which revokes control on every page carrying
 * a transparent portal root, and those are everywhere while a closed-root
 * scrim needs script on the host page to construct (attachShadow is not
 * something CSS can do), which is the residual risk below.
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

/** How many elements the corroboration probe will look at. Only paid on suspicion. */
const MAX_PROBE_ELEMENTS = 4000;

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
/**
 * Is something actually painting opaque pixels over the bar?
 *
 * IntersectionObserver v2 answers a PAINT-ORDER question: `isVisible` is
 * false when anything at all is composited above the target, whether or not
 * it renders a single visible pixel. That is not the question the user cares
 * about. Measured: a `position: fixed; inset: 0; pointer-events: none`
 * container with no background -- the idiom every third-party chat, consent
 * and analytics widget uses for its portal root -- makes it answer "covered"
 * while the bar, the dot, the text and the Stop button are all pixel-for-pixel
 * unchanged. So is a 1x1 transparent div. Acting on that answer alone revoked
 * control, permanently and within a second, on any page carrying one.
 *
 * The observer is therefore a TRIGGER, not a verdict. It is very good at
 * noticing that the stacking above us changed -- it fired in 10ms on a
 * stationary bar, which no polling of ours would match -- and this decides
 * whether what it noticed actually hides anything.
 *
 * This is a much smaller thing than the scan it replaces. It does not have to
 * work out paint order, because the observer has already established that
 * something paints above; it only has to find whether that something is
 * opaque. And it is paid only on suspicion, so the 37ms-per-second cost that
 * made the old scan untenable does not come back.
 *
 * It also replaces an escape hatch that was worse than the problem: the
 * previous version discarded the observer's answer whenever any ancestor had
 * a filter or opacity below 1, to work around its conservatism. A page could
 * write `filter: saturate(1.001)` or `opacity: 0.999` on body -- visually
 * free -- and switch occlusion detection off entirely, and an innocent
 * `drop-shadow` on body did it by accident.
 */
function opaqueCoverAt(win: VisibilityWindow, host: Element, x: number, y: number): boolean {
  // Descends into open shadow roots: querySelectorAll does not cross a shadow
  // boundary, and design-system modals put their backdrop inside one as a
  // matter of course. A CLOSED root cannot be traversed by anyone -- see the
  // module header, where that limit is named.
  const candidates: Element[] = [];
  const collect = (root: { querySelectorAll?(sel: string): ArrayLike<Element> }) => {
    let list: ArrayLike<Element> | undefined;
    try {
      list = root.querySelectorAll?.("*");
    } catch {
      return;
    }
    if (!list) return;
    for (let i = list.length - 1; i >= 0 && candidates.length < MAX_PROBE_ELEMENTS; i--) {
      const el = list[i];
      candidates.push(el);
      const nested = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (nested) collect(nested);
    }
  };
  collect(win.document);

  for (const el of candidates) {
    // Ours, including everything inside our own shadow root -- which
    // contains the bar itself, opaque and directly over the sample point.
    // contains() does not cross a shadow boundary, so outermostHost is what
    // answers "is this part of the widget"; without it the probe found the
    // bar and concluded the bar was covered by the bar.
    if (el === host || outermostHost(el) === host) continue;
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
    if (!style) continue;
    if (style.display === "none" || style.visibility === "hidden") continue;
    const opacity = parseFloat(style.opacity);
    if (Number.isFinite(opacity) && opacity < 0.3) continue;
    if (paintsOpaquely(el, style)) return true;
  }
  return false;
}

/** Tags that render their own pixels rather than just a background. */
const REPLACED_ELEMENTS = new Set([
  "iframe", "frame", "object", "embed", "video", "canvas", "img",
]);

/** Does this element paint something a person would see? */
function paintsOpaquely(
  el: Element,
  style: { backgroundColor?: string; backgroundImage?: string; backdropFilter?: string },
): boolean {
  if (REPLACED_ELEMENTS.has(el.tagName.toLowerCase())) return true;
  const colour = style.backgroundColor;
  if (colour) {
    const m = /rgba?\(([^)]+)\)/.exec(colour);
    if (m) {
      const parts = m[1].split(",").map((p) => parseFloat(p));
      const alpha = parts.length >= 4 ? parts[3] : 1;
      if (Number.isFinite(alpha) && alpha > 0.3) return true;
    } else if (colour !== "transparent") {
      return true;
    }
  }
  const image = style.backgroundImage ?? "none";
  if (image !== "none" && image !== "") return true;
  const backdrop = style.backdropFilter ?? "none";
  return backdrop !== "none" && backdrop !== "";
}

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
  opts: { occluded?: boolean | null } = {},
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
    const effect = hidingEffect(style);
    if (effect) {
      return hidden("control_ui_filtered", `the control bar is ${effect} by the page`);
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
  // The hit test above cannot see a `pointer-events: none` layer, so the
  // browser is asked. Its answer is a trigger, not a verdict -- see
  // opaqueCoverAt -- so a claim of "covered" is corroborated before acting.
  //
  // What counts as covered: the Stop end of the bar. Stop is what has to stay
  // reachable -- the promise is that you can stop it, not that every pixel of
  // the banner is pristine -- and a toast clipping the near end is not a
  // reason to take control away. Measured: a 180x40 notification at the top
  // left leaves Stop untouched and pressable.
  const stopSide = onScreen[onScreen.length - 1];
  if (opts.occluded === true && stopSide && opaqueCoverAt(win, host, stopSide[0], stopSide[1])) {
    return hidden("control_ui_obscured", "something on the page is covering the control bar");
  }

  return VISIBLE;
}
