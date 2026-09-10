/**
 * Let the agent act on the page, through the gate and nothing else.
 *
 * Registered as LiveKit RPC methods rather than data packets, because an
 * action needs an answer: did it happen, was it refused, and what does the
 * page look like now. RPC gives request/response, a timeout and typed errors;
 * a data packet gives none of those, and an agent that cannot tell "refused"
 * from "lost" will retry a payment.
 *
 * Every action returns the FRESH listing, so the agent verifies what it did
 * without a second round trip -- and cannot claim success without evidence.
 *
 * The gate lives in domGate.ts and is consulted here, on this side of the
 * wire. The agent asks; the browser decides. That ordering is the whole
 * safety model: a prompt can be argued out of a rule by the page it is
 * reading, and this cannot be argued with at all.
 */
import { useCallback, useEffect, useRef } from "react";
import { useRoomContext } from "@livekit/components-react";
import { capturePage, resolveRef, listedName, safeTagName, safeInvoke } from "./domReader";
import { evaluateAction, evaluateTyping, visibleText, type GateContext } from "./domGate";
import { controlUiVisibility, type TopLayerState } from "./controlVisibility";

export const RPC_READ_PAGE = "bionic.read_page";
export const RPC_CLICK = "bionic.click";
export const RPC_TYPE_TEXT = "bionic.type_text";
export const RPC_SCROLL = "bionic.scroll";

/** Longest text the agent may type in one call. */
const MAX_TYPE_CHARS = 2000;

/** How often the control UI is re-checked while control is on. */
const VISIBILITY_POLL_MS = 1000;

/**
 * IntersectionObserver v2, which TypeScript's DOM lib does not describe yet.
 *
 * Declared rather than cast through `any` so the two fields actually used
 * keep their types, and so a future lib update conflicts loudly instead of
 * silently disagreeing.
 */
interface VisibilityObserverInit extends IntersectionObserverInit {
  trackVisibility?: boolean;
  /** Required to be >= 100 when trackVisibility is set. */
  delay?: number;
}
interface VisibilityObserverEntry extends IntersectionObserverEntry {
  isVisible?: boolean;
}
type VisibilityObserverCtor = new (
  callback: (entries: VisibilityObserverEntry[]) => void,
  options?: VisibilityObserverInit,
) => IntersectionObserver;

/**
 * Does this browser implement IntersectionObserver **v2**?
 *
 * Not answerable by try/catch around the constructor, which is what this used
 * to do. Firefox and Safari ship v1, and WebIDL says an unknown dictionary
 * member is ignored -- so `{ trackVisibility: true, delay: 150 }` constructs
 * happily there, nothing throws, and every entry simply has no `isVisible`.
 * `!undefined` is `true`, so the old code decided the bar was covered on a
 * pristine page and revoked control on every page in those browsers, one
 * second after the user pressed "Let it act". The exact opposite of what this
 * file documented.
 *
 * The presence of the property on the entry prototype is the real question,
 * so that is what is asked.
 */
function supportsVisibilityObserver(): boolean {
  try {
    return (
      typeof IntersectionObserver !== "undefined" &&
      typeof IntersectionObserverEntry !== "undefined" &&
      "isVisible" in IntersectionObserverEntry.prototype
    );
  } catch {
    return false;
  }
}

export interface ConfirmRequest {
  /** Opaque key to hand back to `confirm()` if the user agrees. */
  key: string;
  /** What the agent wanted to press, for the user to read. */
  name: string;
  detail: string;
}

export interface PageActionsOptions {
  enabled: boolean;
  denylist: string[];
  allowedOrigins: string[];
  /** The control bar, so we can verify the user can still see and stop this. */
  getControlBar: () => Element | null;
  /**
   * Put the bar back in the top layer, and say what state it ended up in.
   *
   * Called before judging: the only thing that can cover a top-layer element
   * is another one opened later, and re-showing ours puts it back on top.
   * `force` does a real hide-then-show; without it, showPopover on an
   * already-open popover is a no-op.
   */
  reassertControlBar?: (force?: boolean) => TopLayerState;
  /** Called when an action is refused, so the widget can show the user. */
  onRefusal?: (detail: string, confirmable?: ConfirmRequest) => void;
  /** Called when the agent acts, so the widget can show what happened. */
  onAction?: (summary: string) => void;
  /** Called when control had to be revoked; the widget must turn it off. */
  onControlRevoked?: (detail: string) => void;
}

/** The shape every RPC method answers with. */
interface ActionResult {
  ok: boolean;
  changed?: boolean;
  reason?: string;
  detail?: string;
  url?: string;
  elements?: ReturnType<typeof capturePage>["elements"];
  truncated?: number;
  unexamined?: number;
}

/**
 * Reading the page must never take the actions down with it.
 *
 * capturePage walks structure the page controls, and a page can make that
 * throw -- `<form role="search"><input name="tagName">` did, because a form's
 * named controls shadow its own methods. The publisher already caught that
 * and degraded to vision-only; these handlers did not, so one piece of
 * markup made all four RPCs answer "the page did not respond" for as long as
 * it existed. The individual reads are hardened now; this is the net under
 * them, because the next such property is not one anybody has thought of.
 */
type Capture = { page: ReturnType<typeof capturePage>; failed: false } | { page: null; failed: true };

function safeCapture(): Capture {
  try {
    return { page: capturePage(document, window), failed: false };
  } catch (error) {
    console.warn("[page] could not read the page:", error);
    return { page: null, failed: true };
  }
}

/**
 * The fresh listing, as the agent should hear it.
 *
 * `changed` is three-valued on purpose: true and false describe an action's
 * effect, and undefined is a plain read with no action to compare against.
 * read_page used to send false, which the agent side rendered as "NOTHING
 * CHANGED. Say so; do not move on" -- on the first read of every
 * conversation. That is the "repeats itself, will not progress" failure goal
 * 1 exists to remove, coming from our own side.
 *
 * A capture that threw is reported as exactly that. Returning an empty
 * listing marked ok made "could not read the page" indistinguishable from
 * "this page has no controls", and the agent told the user the control they
 * were looking at did not exist.
 *
 * `truncated` and `unexamined` ride along. They were computed and then
 * dropped here, so on the path the agent actually works through a 200-line
 * listing always looked complete.
 */
function listingReply(changed: boolean | undefined, cap: Capture = safeCapture()): ActionResult {
  if (cap.failed) {
    return { ok: false, reason: "read_failed", detail: "The page could not be read this time." };
  }
  const page = cap.page;
  const reply: ActionResult = { ok: true, url: page.url, elements: page.elements };
  if (changed !== undefined) reply.changed = changed;
  if (page.truncated) reply.truncated = page.truncated;
  if (page.unexamined) reply.unexamined = page.unexamined;
  return reply;
}

/** The fingerprint of a listing we have already captured. */
function fingerprintOf(page: ReturnType<typeof capturePage>): string {
  return JSON.stringify([
    page.url,
    page.elements.map((e) => [e.role, e.name, e.visible]),
  ]);
}

/**
 * A snapshot of the page, to tell whether an action actually did anything.
 *
 * "Nothing changed" is the answer the agent most needs and is least able to
 * guess: it is the difference between "done, move on" and the repeated
 * identical instruction this feature exists to stop.
 */
function pageFingerprint(): string {
  const cap = safeCapture();
  return cap.failed ? "" : fingerprintOf(cap.page);
}

/**
 * What the model is shown in place of a name it has not got.
 *
 * format_for_model renders an unnamed control as `(no name)`, because a blank
 * where a name should be reads as a rendering fault rather than as a fact
 * about the control. The model copies what it is shown, so the browser has to
 * accept what it showed: without this, every icon-only button with no
 * aria-label -- a hamburger, a close X, a send arrow -- was refused forever
 * with "the page changed", and re-reading produced the identical block. The
 * two halves of the expect contract were written separately and disagreed.
 */
const NO_NAME_PLACEHOLDER = "(no name)";

/** Compare names the way a person would, not the way a page writes them. */
function normaliseName(raw: string): string {
  const cleaned = visibleText(raw || "").toLowerCase().replace(/\s+/g, " ").trim();
  return cleaned === NO_NAME_PLACEHOLDER ? "" : cleaned;
}

/**
 * A confirmation is bound to the element's NAME as well as its ref.
 *
 * A ref names one control, so an approval already cannot slide onto a
 * neighbour. Keying on the name as well covers the remaining case: the same
 * element, renamed since the user was asked about it. An approval only ever
 * spends itself on the thing the user was actually shown.
 */
function confirmKey(ref: string, name: string): string {
  return `${ref} ${normaliseName(name)}`;
}

export function usePageActions(options: PageActionsOptions) {
  const room = useRoomContext();
  const { enabled } = options;

  // Everything except `enabled` and `room` is read through a ref, so a
  // re-render never re-registers the RPC methods. It used to: EmbedClient
  // passed a fresh `[window.location.origin]` array on every render, and
  // every action re-rendered it, so each action tore down and rebuilt all
  // four methods -- a window in which a fast follow-up RPC gets
  // UNSUPPORTED_METHOD, and a Set of user confirmations wiped constantly.
  const latest = useRef(options);
  latest.current = options;

  // Survives re-registration, unlike the effect-scoped Set it replaces.
  // Cleared when control ends and when the page navigates.
  const confirmedKeys = useRef<Set<string>>(new Set());

  const confirm = useCallback((key: string) => {
    confirmedKeys.current.add(key);
  }, []);

  useEffect(() => {
    if (!enabled || !room) return;

    let disposed = false;
    let lastUrl = window.location.href;

    // The browser's own answer to "is something covering the bar".
    // IntersectionObserver v2 (trackVisibility) is the clickjacking-protection
    // primitive, and it replaces a hand-written scan that three review rounds
    // could not get right. null until it has reported, or where it is not
    // supported -- in which case the synchronous checks stand alone and a
    // pointer-events:none scrim is not detected. That is stated in
    // controlVisibility.ts rather than papered over.
    let occluded: boolean | null = null;
    // When that reading was taken, and when we last re-asserted. A reading
    // from before a re-assertion describes a world that no longer exists:
    // the observer is asynchronous (delay: 150), so a synchronous judge
    // microseconds after re-asserting still sees the old answer. Acting on it
    // meant the FIRST report always revoked and the recovery never mattered.
    let occludedAt = 0;
    let reassertedAt = 0;
    let observer: IntersectionObserver | null = null;
    const observeBar = () => {
      const target = latest.current.getControlBar();
      if (!target || !supportsVisibilityObserver()) return;
      try {
        const Observer = IntersectionObserver as unknown as VisibilityObserverCtor;
        observer = new Observer(
          (entries: VisibilityObserverEntry[]) => {
            for (const entry of entries) {
              // Three states, and the difference matters. `isVisible` is only
              // meaningful when the entry actually intersects -- a bar
              // scrolled out of a scroller reports false for a reason the
              // rect check already covers -- and only when the browser
              // actually populated it. Anything else is "we do not know".
              occluded =
                entry.isIntersecting && typeof entry.isVisible === "boolean"
                  ? !entry.isVisible
                  : null;
              occludedAt = Date.now();
            }
          },
          // delay >= 100 is required for trackVisibility.
          { trackVisibility: true, delay: 150, threshold: 0 },
        );
        observer.observe(target);
      } catch {
        observer = null;
        occluded = null;
      }
    };
    observeBar();

    /**
     * How long to allow for the observer to confirm a re-assertion worked.
     *
     * Longer than its own `delay: 150`, and far shorter than the 1s poll, so
     * by the next tick the answer is always in.
     */
    const REASSERT_GRACE_MS = 400;

    /**
     * Is the bar covered by something that survived being re-asserted over?
     *
     * Two ways to know, because the observer reports transitions rather than
     * state:
     *
     *  - It has told us "covered" AGAIN since we re-asserted. That is a page
     *    re-covering us at a rate the observer can still see.
     *
     *  - It has told us NOTHING since we re-asserted, and long enough has
     *    passed that it would have. Silence is not reassurance here: coming
     *    back into view IS a transition, so a working re-assertion produces a
     *    callback. No callback means it did not work -- a page re-covering us
     *    faster than the observer samples. Measured: a plain setInterval at
     *    50ms held the Stop button unclickable for eight seconds with zero
     *    revocations while the agent's click RPC kept succeeding, because the
     *    first test alone waits for a report that never comes.
     *
     * Either way we must have re-asserted at least once first -- a first
     * report is answered by re-asserting, not by stopping.
     *
     * (There is deliberately no "did it report visible since" term. In the
     * branch that would consult it, nothing has been reported since the
     * re-assertion at all, so such a report is necessarily older than it. It
     * was written that way first and carried no weight.)
     */
    const isOccludedNow = () => {
      if (occluded !== true || reassertedAt === 0) return false;
      if (occludedAt > reassertedAt) return true;
      return Date.now() - reassertedAt > REASSERT_GRACE_MS;
    };

    const ctx = (): GateContext => ({
      denylist: latest.current.denylist,
      allowedOrigins: latest.current.allowedOrigins,
      currentOrigin: window.location.origin,
      confirmedRefs: confirmedKeys.current,
    });

    const refuse = (
      reason: string,
      detail: string,
      confirmable?: ConfirmRequest,
    ): string => {
      latest.current.onRefusal?.(detail, confirmable);
      const result: ActionResult = { ok: false, reason, detail };
      return JSON.stringify(result);
    };

    /**
     * Control is only legitimate while the user can see it and stop it.
     *
     * Checked on every action rather than only on a timer, because a timer
     * has a window: a page can hide the bar and issue the action it wanted
     * inside the same second. Revokes on failure -- the honest response to
     * "the Stop button is gone" is to stop.
     */
    const controlIsVisible = (): { ok: true } | { ok: false; reason: string; detail: string } => {
      // Re-assert first, then judge. If a page modal opened over the bar --
      // or merely opened anywhere, since the browser reports our bar as not
      // visible whenever any other top-layer element exists -- putting ours
      // back on top is the fix, not a reason to stop.
      // Re-assert first, then judge. A first report is never acted on: the
      // browser reports our bar as not visible whenever ANY other top-layer
      // element exists -- a cookie dialog in the corner will do it, overlap
      // or not -- and re-asserting puts us back on top, after which it
      // reports visible again. Only a report the observer makes AFTER a
      // re-assertion describes a cover that survived it.
      const actionable = isOccludedNow();
      const topLayer = latest.current.reassertControlBar?.(occluded === true) ?? "unsupported";
      if (occluded === true) reassertedAt = Date.now();
      const verdict = controlUiVisibility(latest.current.getControlBar(), window, {
        occluded: actionable ? true : null,
        topLayer,
      });
      if (verdict.visible) return { ok: true };
      latest.current.onControlRevoked?.(verdict.detail);
      return { ok: false, reason: verdict.reason, detail: verdict.detail };
    };

    /**
     * Resolve a ref AND check it is still the thing the agent named.
     *
     * resolveRef answers "the element this ref named", never "whatever is in
     * that position now" -- see the ref registry in domReader.ts. That closes
     * the reorder case, including the one a name check cannot see: a table
     * where every row has its own "Edit".
     *
     * `expect` is the other half. The element can still be the same node and
     * no longer be the same control -- relabelled by the page between the
     * listing and the click -- so the agent says what it believes it is
     * pressing and the browser checks. A mismatch is refused here, with the
     * current listing attached so it can try again.
     */
    const resolveExpected = (
      ref: string,
      expect: unknown,
    ): { el: Element; name: string } | { error: string } => {
      const el = resolveRef(ref, document, window);
      if (!el) {
        const reply = listingReply(false);
        return {
          error: JSON.stringify({
            ...reply,
            ok: false,
            changed: undefined,
            reason: "ref_not_found",
            detail: `${ref} is not on the page now. Use the listing below and try again.`,
          }),
        };
      }
      const name = listedName(el, document);
      const claimed = typeof expect === "string" ? expect : "";
      if (normaliseName(claimed) !== normaliseName(name)) {
        const reply = listingReply(false);
        return {
          error: JSON.stringify({
            ...reply,
            ok: false,
            changed: undefined,
            reason: "ref_moved",
            detail:
              `${ref} is now "${name}", not "${claimed}". The page changed. ` +
              "Use the listing below and try again.",
          }),
        };
      }
      return { el, name };
    };

    const readPage = async (): Promise<string> => JSON.stringify(listingReply(undefined));

    const click = async (data: { payload: string }): Promise<string> => {
      const vis = controlIsVisible();
      if (!vis.ok) return refuse(vis.reason, vis.detail);

      const { ref, expect } = JSON.parse(data.payload || "{}");
      const refStr = String(ref ?? "");
      const resolved = resolveExpected(refStr, expect);
      if ("error" in resolved) return resolved.error;
      const { el, name } = resolved;

      // The composite key, not the bare ref, is what a confirmation is spent
      // on -- see confirmKey.
      const key = confirmKey(refStr, name);
      const verdict = evaluateAction(el, name, key, ctx());
      if (!verdict.allowed) {
        const confirmable =
          verdict.reason === "awaiting_user_confirmation"
            ? { key, name, detail: verdict.detail }
            : undefined;
        return refuse(verdict.reason, verdict.detail, confirmable);
      }

      // Spent the moment the gate passes, before anything can go wrong.
      //
      // It used to be spent after the click and its 350ms settle, which left
      // a window the approval was still live in. The agent's own runtime
      // opens it: livekit-agents runs the function calls in one LLM response
      // as concurrent tasks, and these tools allow duplicates, so two
      // identical click calls overlap -- one approval, two presses of "Pay
      // now", reproduced. The same window swallowed a failed press: if
      // el.click() threw, the delete never ran and the approval survived for
      // a later, unapproved click.
      confirmedKeys.current.delete(key);

      const before = pageFingerprint();
      safeInvoke(el, "click");
      // Give the page a beat to react before reporting what changed.
      await new Promise((r) => setTimeout(r, 350));
      latest.current.onAction?.(`clicked "${name}"`);
      // One capture, used both to decide whether anything changed and as the
      // reply. It was two, and capturePage walks the whole document.
      const after = safeCapture();
      const changed = after.failed ? undefined : fingerprintOf(after.page) !== before;
      return JSON.stringify(listingReply(changed, after));
    };

    const typeText = async (data: { payload: string }): Promise<string> => {
      const vis = controlIsVisible();
      if (!vis.ok) return refuse(vis.reason, vis.detail);

      const { ref, text, expect } = JSON.parse(data.payload || "{}");
      const refStr = String(ref ?? "");
      const resolved = resolveExpected(refStr, expect);
      if ("error" in resolved) return resolved.error;
      const { el, name } = resolved;

      const verdict = evaluateTyping(el, ctx());
      if (!verdict.allowed) return refuse(verdict.reason, verdict.detail);

      const value = String(text ?? "").slice(0, MAX_TYPE_CHARS);
      const before = pageFingerprint();
      const target = el as HTMLElement;
      safeInvoke(target, "focus");

      const tag = safeTagName(target).toLowerCase();
      if (tag === "input" || tag === "textarea") {
        // Set through the native setter so React and other frameworks that
        // track the value see the change; assigning .value directly is
        // invisible to them and the typing silently does not stick.
        //
        // Chosen by tagName, not instanceof: the element may come from
        // another realm (a same-origin iframe), where instanceof answers
        // "no" for a perfectly ordinary input.
        const field = target as HTMLInputElement | HTMLTextAreaElement;
        const proto =
          tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        try {
          if (setter) setter.call(field, value);
          else field.value = value;
        } catch {
          field.value = value;
        }
      } else if (target.isContentEditable || target.hasAttribute("contenteditable")) {
        // domReader offers contenteditable elements as typeable -- Gmail- and
        // Slack-style editors are all contenteditable -- but they have no
        // `value`, and calling the input setter on one throws "Illegal
        // invocation", so typing into the most common rich editor on the web
        // failed outright.
        target.textContent = value;
      } else {
        return refuse(
          "not_typeable",
          `"${name || refStr}" is not a field that accepts text.`,
        );
      }

      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      latest.current.onAction?.(`typed into "${name || "a field"}"`);
      const after = safeCapture();
      const changed = after.failed ? undefined : fingerprintOf(after.page) !== before;
      return JSON.stringify(listingReply(changed, after));
    };

    const scroll = async (data: { payload: string }): Promise<string> => {
      const vis = controlIsVisible();
      if (!vis.ok) return refuse(vis.reason, vis.detail);

      const { ref, direction } = JSON.parse(data.payload || "{}");
      if (ref) {
        // Scrolling is not actuation: it changes what is visible, never what
        // exists, so it does not carry the expect-check that click and type
        // do. Scrolling to the wrong element is a wasted turn, not a wrong
        // button pressed.
        const el = resolveRef(String(ref), document, window);
        if (!el) {
          return JSON.stringify({
            ok: false,
            reason: "ref_not_found",
            detail: `${ref} is not on the page now. Read it again.`,
          });
        }
        el.scrollIntoView({ block: "center" });
      } else {
        window.scrollBy({ top: direction === "up" ? -600 : 600 });
      }
      await new Promise((r) => setTimeout(r, 250));
      latest.current.onAction?.("scrolled");
      // Scrolling changes what is visible, never what exists, so it always
      // reports changed: the visible flags in the listing really did move.
      return JSON.stringify(listingReply(true));
    };

    const methods: Array<[string, (d: any) => Promise<string>]> = [
      [RPC_READ_PAGE, readPage],
      [RPC_CLICK, click],
      [RPC_TYPE_TEXT, typeText],
      [RPC_SCROLL, scroll],
    ];

    for (const [name, handler] of methods) {
      try {
        room.localParticipant.registerRpcMethod(name, handler as never);
      } catch (error) {
        console.warn(`[page] could not register ${name}:`, error);
      }
    }

    // The action-time check closes the window a timer leaves open; this
    // closes the opposite one, where the bar is hidden and the agent simply
    // waits. Control that nobody can see should not sit there armed.
    const poll = window.setInterval(() => {
      if (disposed) return;
      // A navigation invalidates every ref, and with it every approval the
      // user gave against one.
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        confirmedKeys.current.clear();
      }
      // The same check as an action's. It used to be a cheaper variant,
      // because the overlay scan cost 37ms at 4x CPU throttle and ran every
      // second; reading the observer's flag costs nothing, so the heartbeat
      // and the action path can be the same thing again.
      const actionable = isOccludedNow();
      const topLayer = latest.current.reassertControlBar?.(occluded === true) ?? "unsupported";
      if (occluded === true) reassertedAt = Date.now();
      const verdict = controlUiVisibility(latest.current.getControlBar(), window, {
        occluded: actionable ? true : null,
        topLayer,
      });
      if (!verdict.visible) latest.current.onControlRevoked?.(verdict.detail);
    }, VISIBILITY_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(poll);
      observer?.disconnect();
      for (const [name] of methods) {
        try {
          room.localParticipant.unregisterRpcMethod(name);
        } catch {
          // Unregistering something that was never registered is not a
          // problem worth surfacing during teardown.
        }
      }
      confirmedKeys.current.clear();
    };
  }, [enabled, room]);

  return { confirm };
}
