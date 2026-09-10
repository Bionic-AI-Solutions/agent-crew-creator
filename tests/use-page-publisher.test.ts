/**
 * Tests for usePagePublisher.
 *
 * The hook has no test file anywhere on this branch, despite being the one
 * piece of live Phase A code that runs on every mutation of the host page
 * and shares the reliable data channel with audio. This pins the behaviour
 * that matters most for that: it captures once when the room is already
 * connected, coalesces bursts of mutations onto the MIN_INTERVAL_MS floor
 * rather than sending one per mutation, skips an unchanged page, and stops
 * touching the room once unmounted.
 *
 * Run: npx tsx --test tests/use-page-publisher.test.ts
 */
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.com/app",
});

// usePagePublisher.ts reaches for the ambient `document`/`window`/
// `MutationObserver` rather than taking them as arguments, so the test
// environment has to supply real globals before anything imports it.
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
try {
  (globalThis as any).navigator = dom.window.navigator;
} catch {
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
}
(globalThis as any).MutationObserver = dom.window.MutationObserver;
(globalThis as any).Node = dom.window.Node;
(globalThis as any).Element = dom.window.Element;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  dom.window.setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id as unknown as NodeJS.Timeout);

// jsdom reports every element as zero-area; capturePage treats a zero-area
// element as unrendered and would filter every element out otherwise.
(dom.window.Element.prototype as any).getBoundingClientRect = function () {
  const style = dom.window.getComputedStyle(this as Element);
  if (style.display === "none") {
    return { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
  }
  return { width: 100, height: 20, top: 10, left: 10, bottom: 30, right: 110 };
};

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { RoomContext } = await import("@livekit/components-react");
const { RoomEvent } = await import("livekit-client");
const { usePagePublisher, PAGE_TOPIC } = await import(
  "../client/src/embed/usePagePublisher.ts"
);

function flushMicrotasks() {
  return delay(0);
}

function makeFakeRoom(state: string = "connected") {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const sendText = mock.fn(async (_text: string, _opts: any) => {});
  return {
    room: {
      state,
      localParticipant: { sendText },
      on(event: string, cb: (...args: any[]) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(cb);
        return this;
      },
      off(event: string, cb: (...args: any[]) => void) {
        listeners.get(event)?.delete(cb);
        return this;
      },
      emit(event: string, ...args: any[]) {
        for (const cb of listeners.get(event) ?? []) cb(...args);
      },
    } as any,
    sendText,
  };
}

function Harness(props: { room: any; enabled: boolean }) {
  usePagePublisher(props.enabled);
  return null;
}

function mount(room: any, enabled: boolean) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    React.createElement(
      RoomContext.Provider,
      { value: room },
      React.createElement(Harness, { room, enabled })
    )
  );
  return {
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

describe("usePagePublisher", () => {
  test("publishes once on mount when the room is already connected", async () => {
    dom.window.document.body.innerHTML = '<button aria-label="Save">Save</button>';
    const { room, sendText } = makeFakeRoom("connected");
    const h = mount(room, true);
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(sendText.mock.callCount(), 1, "expected exactly one initial publish");
    const [payload, opts] = sendText.mock.calls[0].arguments;
    assert.equal(opts.topic, PAGE_TOPIC);
    const listing = JSON.parse(payload);
    assert.equal(listing.url, "https://example.com/app");
    assert.ok(
      listing.elements.some((e: any) => e.name === "Save"),
      "listing should contain the Save button"
    );

    h.unmount();
  });

  test("does not publish while the room is still connecting", async () => {
    dom.window.document.body.innerHTML = '<button aria-label="X">X</button>';
    const { room, sendText } = makeFakeRoom("connecting");
    const h = mount(room, true);
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(sendText.mock.callCount(), 0, "must not publish before the room connects");

    // Simulate the room finishing connect: nothing re-triggers publish until
    // RoomEvent.Connected fires, which is exactly what the hook listens for.
    room.state = "connected";
    room.emit(RoomEvent.Connected);
    // schedule() debounces onto MIN_INTERVAL_MS even for this first publish.
    await delay(1300);
    await flushMicrotasks();
    assert.equal(sendText.mock.callCount(), 1, "connecting -> connected must trigger the first publish");

    h.unmount();
  });

  test("coalesces a burst of mutations onto one publish at the MIN_INTERVAL_MS floor", async () => {
    dom.window.document.body.innerHTML = '<button aria-label="One">One</button>';
    const { room, sendText } = makeFakeRoom("connected");
    const h = mount(room, true);
    await flushMicrotasks();
    await flushMicrotasks();
    assert.equal(sendText.mock.callCount(), 1, "initial publish");
    sendText.mock.resetCalls();

    // A burst of DOM mutations in quick succession -- e.g. a form re-rendering
    // -- must not turn into one sendText per mutation.
    for (let i = 0; i < 5; i++) {
      dom.window.document.body.innerHTML = `<button aria-label="Two-${i}">Two</button>`;
    }

    // Nothing sent yet: still inside the debounce window.
    await flushMicrotasks();
    assert.equal(sendText.mock.callCount(), 0, "must not publish before MIN_INTERVAL_MS elapses");

    await delay(1300);
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(
      sendText.mock.callCount(),
      1,
      "five mutations inside the debounce window must coalesce into exactly one publish"
    );

    h.unmount();
  });

  test("an unchanged page is not republished", async () => {
    dom.window.document.body.innerHTML = '<button aria-label="Same">Same</button>';
    const { room, sendText } = makeFakeRoom("connected");
    const h = mount(room, true);
    await flushMicrotasks();
    await flushMicrotasks();
    assert.equal(sendText.mock.callCount(), 1);
    sendText.mock.resetCalls();

    // An attribute mutation the observer watches, but the resulting listing
    // (name/role/visibility) is identical -- e.g. a style recalculation that
    // doesn't change anything the agent is told about.
    dom.window.document.querySelector("button")!.setAttribute("style", "color:red");

    await delay(1300);
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(sendText.mock.callCount(), 0, "an unchanged listing must not be resent");

    h.unmount();
  });

  test("stops publishing after unmount even if a debounced timer was pending", async () => {
    dom.window.document.body.innerHTML = '<button aria-label="Init">Init</button>';
    const { room, sendText } = makeFakeRoom("connected");
    const h = mount(room, true);
    await flushMicrotasks();
    await flushMicrotasks();
    sendText.mock.resetCalls();

    dom.window.document.body.innerHTML = '<button aria-label="Changed">Changed</button>';
    h.unmount();

    await delay(1300);
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(sendText.mock.callCount(), 0, "an unmounted publisher must never call sendText");
  });
});
