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
import { capturePage, resolveRef, accessibleName } from "./domReader";
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

function listingReply(changed: boolean): ActionResult {
  const page = capturePage(document, window);
  return { ok: true, changed, url: page.url, elements: page.elements };
}

/**
 * A snapshot of the page, to tell whether an action actually did anything.
 *
 * "Nothing changed" is the answer the agent most needs and is least able to
 * guess: it is the difference between "done, move on" and the repeated
 * identical instruction this feature exists to stop.
 */
function pageFingerprint(): string {
  const page = capturePage(document, window);
  return JSON.stringify([
    page.url,
    page.elements.map((e) => [e.role, e.name, e.visible]),
  ]);
}

/** Compare names the way a person would, not the way a page writes them. */
function normaliseName(raw: string): string {
  return visibleText(raw || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A confirmation is bound to the element's NAME as well as its ref.
 *
 * A ref is a position in the current listing, so "the user approved ref_7"
 * would survive the page reordering and approve whatever slid into seventh
 * place. Keying on the name too means an approval only ever spends itself on
 * the thing the user was actually shown.
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
      const verdict = controlUiVisibility(latest.current.getControlBar(), window);
      if (verdict.visible) return { ok: true };
      latest.current.onControlRevoked?.(verdict.detail);
      return { ok: false, reason: verdict.reason, detail: verdict.detail };
    };

    /**
     * Resolve a ref AND check it is still the thing the agent named.
     *
     * Refs are positional: resolveRef recomputes the ordering at act time, so
     * `ref_7` means "the seventh interactive element right now", not "the
     * element I described a moment ago". On a page that reorders between the
     * listing and the click -- a toast appearing, a row loading -- that is a
     * click on a different control. The gate still re-reads the LIVE
     * element's name, so a denylisted one is still refused; what was missing
     * was any check that a harmless-but-different element had taken its place.
     *
     * So the agent has to say what it thinks it is pressing, and the browser
     * checks. Not a prompt rule asking it to re-read: a mismatch is refused
     * here, with the current listing attached so it can try again.
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
      const name = accessibleName(el);
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
      return JSON.stringify(listingReply(pageFingerprint() !== before));
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
      return JSON.stringify(listingReply(pageFingerprint() !== before));
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
      const verdict = controlUiVisibility(latest.current.getControlBar(), window);
      if (!verdict.visible) latest.current.onControlRevoked?.(verdict.detail);
    }, VISIBILITY_POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(poll);
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
