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
import { capturePage, resolveRef, listedName } from "./domReader";
import { evaluateAction, evaluateTyping, visibleText, type GateContext } from "./domGate";
import { controlUiVisibility } from "./controlVisibility";

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
   * Put the bar back in the top layer, and say whether it is there.
   *
   * Called before acting on a report that something is covering it: the only
   * thing that can cover a top-layer element is another one opened later, and
   * re-showing ours puts it back on top. A report that survives that is real.
   */
  reassertControlBar?: () => boolean;
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
}

function listingReply(changed: boolean, page = capturePage(document, window)): ActionResult {
  return { ok: true, changed, url: page.url, elements: page.elements };
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
  return fingerprintOf(capturePage(document, window));
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
      // Re-assert first, then judge. If a page modal opened over the bar,
      // putting ours back on top is the fix, not a reason to stop -- and if
      // the report survives it, something really is there.
      const inTopLayer = latest.current.reassertControlBar?.() ?? false;
      const verdict = controlUiVisibility(latest.current.getControlBar(), window, {
        occluded,
        inTopLayer,
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

    const readPage = async (): Promise<string> => JSON.stringify(listingReply(false));

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

      const before = pageFingerprint();
      (el as HTMLElement).click();
      // Give the page a beat to react before reporting what changed.
      await new Promise((r) => setTimeout(r, 350));
      // Spent: an approval is for one press, not for the rest of the session.
      confirmedKeys.current.delete(key);
      latest.current.onAction?.(`clicked "${name}"`);
      // One capture, used both to decide whether anything changed and as the
      // reply. It was two, and capturePage walks the whole document.
      const after = capturePage(document, window);
      return JSON.stringify(listingReply(fingerprintOf(after) !== before, after));
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
      target.focus();

      const tag = target.tagName.toLowerCase();
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
      const after = capturePage(document, window);
      return JSON.stringify(listingReply(fingerprintOf(after) !== before, after));
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
      const inTopLayer = latest.current.reassertControlBar?.() ?? false;
      const verdict = controlUiVisibility(latest.current.getControlBar(), window, {
        occluded,
        inTopLayer,
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
