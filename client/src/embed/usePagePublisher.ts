/**
 * Publish a listing of the host page's controls to the agent.
 *
 * Only runs when the agent is capable of reading a page AND this embed token
 * permits it, which the server has already ANDed together by the time the
 * config arrives here.
 *
 * Published as a text stream on `lk.page`, never as a chat message: a chat
 * message is a user turn, and the agent would answer every page load. That is
 * the "talks too much" defect, already fixed once.
 */
import { useEffect, useRef } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent } from "livekit-client";
import { capturePage } from "./domReader";

export const PAGE_TOPIC = "lk.page";

/**
 * How often the page is re-read while it is changing.
 *
 * Not a live subscription to every mutation: a busy app mutates constantly,
 * and the agent only needs the page as it stands when the user speaks. This
 * is the floor between captures, not a fixed heartbeat -- an idle page costs
 * nothing because an unchanged listing is never republished.
 */
const MIN_INTERVAL_MS = 1200;

/**
 * A page that has not changed is not worth sending again.
 *
 * JSON rather than a joined string. The previous version separated fields
 * with "|", which is a character real UI text contains all the time --
 * breadcrumbs, "Yes | No", price ranges -- so two genuinely different pages
 * could produce the same signature and a real change would be silently
 * treated as no change. JSON quotes and escapes each field, so nothing a
 * page can write moves a boundary.
 *
 * (An earlier version used raw NUL/SOH/STX, which no page contains but which
 * made git classify this file as binary and hide its diff entirely.)
 */
export function signature(listing: ReturnType<typeof capturePage>): string {
  return JSON.stringify([
    listing.url,
    listing.elements.map((e) => [e.role, e.name, e.visible]),
  ]);
}

export function usePagePublisher(enabled: boolean) {
  const room = useRoomContext();
  // Held in a ref, not state: changing it must never re-render the widget.
  const lastSignature = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !room) return;

    let cancelled = false;
    let timer: number | undefined;
    // sendText waits on the reliable data channel draining, which can stall
    // through a reconnect. Without this, each mutation 1.2s later would start
    // another independent publish on top of the stalled one.
    let inFlight = false;
    // A capture that arrived while a send was in flight. Without this it was
    // simply dropped: the guard returned, nothing was queued, and on a page
    // that then went quiet the agent kept describing the state before the
    // change until the listing aged out two minutes later.
    let missed = false;

    const publish = async () => {
      if (cancelled || room.state !== "connected") return;
      if (inFlight) {
        missed = true;
        return;
      }
      inFlight = true;
      try {
        const listing = capturePage(document, window);
        const sig = signature(listing);
        if (sig === lastSignature.current) return;
        await room.localParticipant.sendText(JSON.stringify(listing), { topic: PAGE_TOPIC });
        // Only after the send resolves, and only if this effect is still the
        // live one. lastSignature is a ref shared across effect re-runs, so a
        // publish left in flight by a reconnect could resolve after the
        // replacement effect had already published something newer and
        // overwrite it -- leaving the agent believing a page it had moved on
        // from was still current.
        if (cancelled) return;
        lastSignature.current = sig;
      } catch (error) {
        // The agent degrades to vision-only without a listing. It must not
        // lose the session because a page could not be read -- a host page
        // can throw from getComputedStyle on a detached node, among others.
        console.warn("[page] could not publish listing:", error);
      } finally {
        inFlight = false;
        // Whatever changed while this send was busy still needs sending.
        if (missed && !cancelled) {
          missed = false;
          schedule();
        }
      }
    };

    // Re-read on the things that actually change a page: the user did
    // something, the DOM changed, or the app navigated. Coalesced onto a
    // timer so a chatty app cannot turn this into a publish loop.
    //
    // `function` rather than `const`: publish() retries through it, and it is
    // declared after publish() so a const would be in its temporal dead zone.
    let pending = false;
    function schedule() {
      if (pending || cancelled) return;
      pending = true;
      timer = window.setTimeout(() => {
        pending = false;
        void publish();
      }, MIN_INTERVAL_MS);
    };

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-hidden", "hidden", "disabled", "role", "style"],
    });

    // The room is usually still connecting when this mounts: EmbedClient
    // renders the publisher as soon as connection details arrive, and
    // connect() resolves later. publish() bails on a room that is not
    // connected, and nothing re-ran it -- so the very first listing waited
    // for an incidental DOM event, and a user whose first words were "what is
    // on this page?" got no listing at all. Same gap on every reconnect.
    room.on(RoomEvent.Connected, schedule);
    room.on(RoomEvent.Reconnected, schedule);

    window.addEventListener("popstate", schedule);
    window.addEventListener("hashchange", schedule);
    document.addEventListener("click", schedule, true);
    document.addEventListener("keyup", schedule, true);

    void publish();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      observer.disconnect();
      room.off(RoomEvent.Connected, schedule);
      room.off(RoomEvent.Reconnected, schedule);
      window.removeEventListener("popstate", schedule);
      window.removeEventListener("hashchange", schedule);
      document.removeEventListener("click", schedule, true);
      document.removeEventListener("keyup", schedule, true);
      lastSignature.current = null;
    };
  }, [enabled, room]);
}

/** Exposed for tests; the signature decides whether a change is sent at all. */
export { signature as signatureForTest };
