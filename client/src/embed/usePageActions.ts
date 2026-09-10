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
 * without a second round trip — and cannot claim success without evidence.
 *
 * The gate lives in domGate.ts and is consulted here, on this side of the
 * wire. The agent asks; the browser decides. That ordering is the whole
 * safety model: a prompt can be argued out of a rule by the page it is
 * reading, and this cannot be argued with at all.
 */
import { useEffect } from "react";
import { useRoomContext } from "@livekit/components-react";
import { capturePage, resolveRef, accessibleName } from "./domReader";
import { evaluateAction, evaluateTyping, type GateContext } from "./domGate";

export const RPC_READ_PAGE = "bionic.read_page";
export const RPC_CLICK = "bionic.click";
export const RPC_TYPE_TEXT = "bionic.type_text";
export const RPC_SCROLL = "bionic.scroll";

/** Longest text the agent may type in one call. */
const MAX_TYPE_CHARS = 2000;

export interface PageActionsOptions {
  enabled: boolean;
  denylist: string[];
  allowedOrigins: string[];
  /** Called when an action is refused, so the widget can show the user. */
  onRefusal?: (detail: string) => void;
  /** Called when the agent acts, so the widget can show what happened. */
  onAction?: (summary: string) => void;
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

export function usePageActions(options: PageActionsOptions) {
  const room = useRoomContext();
  const { enabled, denylist, allowedOrigins, onRefusal, onAction } = options;

  useEffect(() => {
    if (!enabled || !room) return;

    // Refusals are per ref, per session, and are cleared whenever the page
    // moves on: a ref means something different after the next capture, so a
    // confirmation carried across one would approve an action the user never
    // saw.
    const confirmedRefs = new Set<string>();

    const ctx = (): GateContext => ({
      denylist,
      allowedOrigins,
      currentOrigin: window.location.origin,
      confirmedRefs,
    });

    const refuse = (reason: string, detail: string): ActionResult => {
      onRefusal?.(detail);
      return { ok: false, reason, detail };
    };

    const readPage = async (): Promise<string> =>
      JSON.stringify(listingReply(false));

    const click = async (data: { payload: string }): Promise<string> => {
      const { ref } = JSON.parse(data.payload || "{}");
      const el = resolveRef(String(ref ?? ""), document, window);
      if (!el) {
        return JSON.stringify({
          ok: false,
          reason: "ref_not_found",
          detail: `${ref} is not on the page now. Read it again.`,
        });
      }
      const name = accessibleName(el);
      const verdict = evaluateAction(el, name, String(ref), ctx());
      if (!verdict.allowed) return JSON.stringify(refuse(verdict.reason, verdict.detail));

      const before = pageFingerprint();
      (el as HTMLElement).click();
      // Give the page a beat to react before reporting what changed.
      await new Promise((r) => setTimeout(r, 350));
      onAction?.(`clicked "${name}"`);
      return JSON.stringify(listingReply(pageFingerprint() !== before));
    };

    const typeText = async (data: { payload: string }): Promise<string> => {
      const { ref, text } = JSON.parse(data.payload || "{}");
      const el = resolveRef(String(ref ?? ""), document, window);
      if (!el) {
        return JSON.stringify({
          ok: false,
          reason: "ref_not_found",
          detail: `${ref} is not on the page now. Read it again.`,
        });
      }
      const verdict = evaluateTyping(el, ctx());
      if (!verdict.allowed) return JSON.stringify(refuse(verdict.reason, verdict.detail));

      const value = String(text ?? "").slice(0, MAX_TYPE_CHARS);
      const before = pageFingerprint();
      const field = el as HTMLInputElement | HTMLTextAreaElement;
      // Set through the native setter so React and other frameworks that
      // track the value see the change; assigning .value directly is
      // invisible to them and the typing silently does not stick.
      const proto =
        field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      field.focus();
      if (setter) setter.call(field, value);
      else field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      onAction?.(`typed into "${accessibleName(el) || "a field"}"`);
      return JSON.stringify(listingReply(pageFingerprint() !== before));
    };

    const scroll = async (data: { payload: string }): Promise<string> => {
      const { ref, direction } = JSON.parse(data.payload || "{}");
      if (ref) {
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
      onAction?.("scrolled");
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

    return () => {
      for (const [name] of methods) {
        try {
          room.localParticipant.unregisterRpcMethod(name);
        } catch {
          // Unregistering something that was never registered is not a
          // problem worth surfacing during teardown.
        }
      }
      confirmedRefs.clear();
    };
  }, [enabled, room, denylist, allowedOrigins, onRefusal, onAction]);
}
