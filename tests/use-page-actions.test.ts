/**
 * Tests for usePageActions — the agent clicking and typing on the user's page.
 *
 * The scaffolding here (jsdom globals, the rect shim, the fake room) started
 * as the file written during adversarial review of Phase B. The tests are the
 * fixes for what that review found:
 *
 *  1. Control kept working while the banner -- and Stop -- were hidden by the
 *     host page's own CSS. Every action now verifies the user can still see
 *     and stop it, and revokes control when they cannot.
 *  3. Typing into a contenteditable threw "Illegal invocation" and never
 *     typed, because the native input value setter was called on an element
 *     that has no value.
 *  4. Refs are positional. If the page reordered between the listing and the
 *     click, the same ref was a different control and nothing checked. The
 *     agent now says what it believes it is pressing, and the browser refuses
 *     a mismatch.
 *  5. A fresh `allowedOrigins` array on every render tore down and rebuilt all
 *     four RPC registrations after every single action.
 *  6. The gate's "ask the user first" path had no way for a user to say yes,
 *     so an approved action was refused forever.
 *
 * Run: npx tsx --test tests/use-page-actions.test.ts
 */
import { test, describe, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.com/app",
});

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
(globalThis as any).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as any).HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
(globalThis as any).Event = dom.window.Event;
(globalThis as any).getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
  dom.window.setTimeout(() => cb(Date.now()), 0) as unknown as number;
(globalThis as any).cancelAnimationFrame = (id: number) =>
  dom.window.clearTimeout(id as unknown as NodeJS.Timeout);

// jsdom reports every element as zero-area; capturePage/resolveRef treat a
// zero-area element as unrendered and would filter every element out
// otherwise (same shim as tests/use-page-publisher.test.ts).
(dom.window.Element.prototype as any).getBoundingClientRect = function () {
  const style = dom.window.getComputedStyle(this as Element);
  if (style.display === "none") {
    return { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
  }
  return { width: 100, height: 20, top: 10, left: 10, bottom: 30, right: 110 };
};

// jsdom has no layout, so elementFromPoint throws "not implemented". The
// visibility check treats a throw as "not visible" (it fails closed), which
// would make every action in this file refuse. Point it at whatever the
// current test is using as its control bar.
let currentBar: Element | null = null;
(dom.window.document as any).elementFromPoint = () => currentBar;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { RoomContext } = await import("@livekit/components-react");
const { usePageActions, RPC_CLICK, RPC_TYPE_TEXT, RPC_READ_PAGE, RPC_SCROLL } = await import(
  "../client/src/embed/usePageActions.ts"
);
type ConfirmRequest = import("../client/src/embed/usePageActions.ts").ConfirmRequest;

const ORIGIN = "https://example.com";

async function flushMicrotasks() {
  await delay(0);
  await delay(0);
}

/** A control bar that passes every visibility check. */
function makeVisibleBar(): HTMLElement {
  const bar = dom.window.document.createElement("div");
  bar.id = "bionic-test-bar";
  dom.window.document.body.appendChild(bar);
  currentBar = bar;
  return bar as unknown as HTMLElement;
}

function makeFakeRoom() {
  const handlers = new Map<string, (d: any) => Promise<string>>();
  const registerRpcMethod = mock.fn((name: string, handler: any) => {
    if (handlers.has(name)) throw new Error(`already registered: ${name}`);
    handlers.set(name, handler);
  });
  const unregisterRpcMethod = mock.fn((name: string) => {
    handlers.delete(name);
  });
  return {
    room: { localParticipant: { registerRpcMethod, unregisterRpcMethod } } as any,
    handlers,
    registerRpcMethod,
    unregisterRpcMethod,
  };
}

interface HarnessProps {
  room: any;
  enabled: boolean;
  denylist: string[];
  allowedOrigins: string[];
  getControlBar: () => Element | null;
  onRefusal?: (d: string, c?: ConfirmRequest) => void;
  onAction?: (s: string) => void;
  onControlRevoked?: (d: string) => void;
  /** Receives the hook's confirm() so a test can act as the user saying yes. */
  onReady?: (api: { confirm: (key: string) => void }) => void;
}

function Harness(props: HarnessProps) {
  const api = usePageActions({
    enabled: props.enabled,
    denylist: props.denylist,
    allowedOrigins: props.allowedOrigins,
    getControlBar: props.getControlBar,
    onRefusal: props.onRefusal,
    onAction: props.onAction,
    onControlRevoked: props.onControlRevoked,
  });
  props.onReady?.(api);
  return null;
}

/**
 * Everything mounted, so teardown can be unconditional.
 *
 * The hook holds a 1s interval while control is on, and it is only cleared by
 * unmounting. A failed assertion skips whatever unmount call follows it, and
 * that live interval then keeps node:test's process alive forever -- the
 * suite hangs instead of reporting the failure, which is the one thing a test
 * must never do. Every test registers its handle here and the runner tears
 * them all down whether it passed or not.
 */
const mounted: Array<{ unmount: () => void }> = [];

function unmountAll() {
  while (mounted.length) {
    try {
      mounted.pop()!.unmount();
    } catch {
      // Teardown of an already-broken tree is not worth failing over.
    }
  }
}

function mount(room: any, props: Omit<HarnessProps, "room">) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  const render = (p: Omit<HarnessProps, "room">) =>
    root.render(
      React.createElement(
        RoomContext.Provider,
        { value: room },
        React.createElement(Harness, { room, ...p }),
      ),
    );
  render(props);
  const handle = {
    rerender: render,
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
  mounted.push(handle);
  return handle;
}

// Teardown runs after every test via afterEach, below.
afterEach(unmountAll);

/** Invoke one registered RPC method the way the agent would. */
async function callRpc(
  handlers: Map<string, (d: any) => Promise<string>>,
  method: string,
  payload: unknown,
) {
  const handler = handlers.get(method);
  assert.ok(handler, `${method} is not registered`);
  return JSON.parse(await handler!({ payload: JSON.stringify(payload) }));
}

describe("usePageActions — registration", () => {
  test("registers all four RPC methods when enabled, none when disabled", async () => {
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    const h = mount(room, {
      enabled: true,
      denylist: [],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
    });
    await flushMicrotasks();
    assert.deepEqual(
      [...handlers.keys()].sort(),
      [RPC_CLICK, RPC_READ_PAGE, RPC_SCROLL, RPC_TYPE_TEXT].sort(),
    );
    h.unmount();

    const { room: room2, handlers: handlers2 } = makeFakeRoom();
    const h2 = mount(room2, {
      enabled: false,
      denylist: [],
      allowedOrigins: [],
      getControlBar: () => bar,
    });
    await flushMicrotasks();
    assert.equal(handlers2.size, 0, "nothing registered while disabled");
    h2.unmount();
  });

  test("a re-render with a new-but-equal allowedOrigins array does not re-register", async () => {
    // EmbedClient re-renders after every action, and used to pass a fresh
    // [window.location.origin] each time. As an effect dependency that tore
    // down and rebuilt all four methods after every single action.
    const bar = makeVisibleBar();
    const { room, registerRpcMethod, unregisterRpcMethod } = makeFakeRoom();
    const h = mount(room, {
      enabled: true,
      denylist: [],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
    });
    await flushMicrotasks();
    assert.equal(registerRpcMethod.mock.callCount(), 4);

    h.rerender({
      enabled: true,
      denylist: [],
      // A new array with identical contents -- what a fresh literal produces.
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
    });
    await flushMicrotasks();

    assert.equal(registerRpcMethod.mock.callCount(), 4, "must not re-register");
    assert.equal(unregisterRpcMethod.mock.callCount(), 0, "must not unregister");
    h.unmount();
  });
});

describe("usePageActions — the user can always see and stop it", () => {
  test("a click is refused and control revoked when the bar is hidden by the page", async () => {
    // The blocking review finding, reproduced: the host page hides the
    // wrapper, the banner and Stop go with it, and control used to keep
    // working invisibly.
    dom.window.document.body.innerHTML = '<button id="go">Continue</button>';
    const bar = makeVisibleBar();
    bar.style.display = "none";

    const { room, handlers } = makeFakeRoom();
    let clicked = false;
    dom.window.document.getElementById("go")!.addEventListener("click", () => {
      clicked = true;
    });
    const revoked: string[] = [];
    const h = mount(room, {
      enabled: true,
      denylist: [],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
      onControlRevoked: (d) => revoked.push(d),
    });
    await flushMicrotasks();

    const res = await callRpc(handlers, RPC_CLICK, { ref: "ref_1", expect: "Continue" });
    assert.equal(res.ok, false);
    assert.equal(clicked, false, "the element must not be clicked");
    assert.ok(revoked.length > 0, "control must be revoked");
    h.unmount();
  });

  test("a click goes through when the bar is visible", async () => {
    dom.window.document.body.innerHTML = '<button id="go">Continue</button>';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    let clicked = false;
    dom.window.document.getElementById("go")!.addEventListener("click", () => {
      clicked = true;
    });
    const h = mount(room, {
      enabled: true,
      denylist: [],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
    });
    await flushMicrotasks();

    const res = await callRpc(handlers, RPC_CLICK, { ref: "ref_1", expect: "Continue" });
    assert.equal(res.ok, true);
    assert.equal(clicked, true);
    h.unmount();
  });
});

describe("usePageActions — a ref must still be what the agent named", () => {
  test("a ref that now points at a different control is refused, not clicked", async () => {
    dom.window.document.body.innerHTML = '<button id="a">Details</button>';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();

    // The page reorders: something else is now first in the listing.
    const intruder = dom.window.document.createElement("button");
    intruder.textContent = "Unsubscribe from everything";
    dom.window.document.body.insertBefore(intruder, dom.window.document.getElementById("a"));
    let intruderClicked = false;
    intruder.addEventListener("click", () => {
      intruderClicked = true;
    });

    const h = mount(room, {
      enabled: true,
      denylist: [],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
    });
    await flushMicrotasks();

    // The agent still believes ref_1 is "Details".
    const res = await callRpc(handlers, RPC_CLICK, { ref: "ref_1", expect: "Details" });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "ref_moved");
    assert.equal(intruderClicked, false, "the wrong control must not be pressed");
    // The refusal carries the current listing so the agent can recover.
    assert.ok(Array.isArray(res.elements) && res.elements.length > 0);
    h.unmount();
  });

  test("an omitted expect is refused rather than trusted", async () => {
    dom.window.document.body.innerHTML = '<button id="a">Details</button>';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    let clicked = false;
    dom.window.document.getElementById("a")!.addEventListener("click", () => {
      clicked = true;
    });
    const h = mount(room, {
      enabled: true,
      denylist: [],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
    });
    await flushMicrotasks();

    const res = await callRpc(handlers, RPC_CLICK, { ref: "ref_1" });
    assert.equal(res.ok, false);
    assert.equal(clicked, false);
    h.unmount();
  });
});

describe("usePageActions — typing", () => {
  test("types into a contenteditable instead of throwing", async () => {
    // domReader offers contenteditable elements as typeable, and the native
    // input value setter throws "Illegal invocation" on one.
    dom.window.document.body.innerHTML =
      '<div id="ed" contenteditable="true" aria-label="Message body"></div>';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    const h = mount(room, {
      enabled: true,
      denylist: [],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
    });
    await flushMicrotasks();

    const res = await callRpc(handlers, RPC_TYPE_TEXT, {
      ref: "ref_1",
      text: "hello there",
      expect: "Message body",
    });
    assert.equal(res.ok, true, `typing should succeed, got ${JSON.stringify(res)}`);
    assert.equal(dom.window.document.getElementById("ed")!.textContent, "hello there");
    h.unmount();
  });

  test("types into an ordinary input", async () => {
    dom.window.document.body.innerHTML = '<input id="f" aria-label="Search" />';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    const h = mount(room, {
      enabled: true,
      denylist: [],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
    });
    await flushMicrotasks();

    const res = await callRpc(handlers, RPC_TYPE_TEXT, {
      ref: "ref_1",
      text: "kettles",
      expect: "Search",
    });
    assert.equal(res.ok, true);
    assert.equal(
      (dom.window.document.getElementById("f") as HTMLInputElement).value,
      "kettles",
    );
    h.unmount();
  });
});

describe("usePageActions — asking the user first", () => {
  test("a denylisted click is refused, offers a confirmation, and is not clicked", async () => {
    dom.window.document.body.innerHTML = '<button id="d">Delete account</button>';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    let clicked = false;
    dom.window.document.getElementById("d")!.addEventListener("click", () => {
      clicked = true;
    });
    const offered: ConfirmRequest[] = [];
    const h = mount(room, {
      enabled: true,
      denylist: ["delete"],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
      onRefusal: (_d, c) => {
        if (c) offered.push(c);
      },
    });
    await flushMicrotasks();

    const res = await callRpc(handlers, RPC_CLICK, {
      ref: "ref_1",
      expect: "Delete account",
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "awaiting_user_confirmation");
    assert.equal(clicked, false);
    assert.equal(offered.length, 1, "the user must be offered the choice");
    h.unmount();
  });

  test("after the user allows it, the same click goes through exactly once", async () => {
    // Before this, the gate refused every denylisted action and nothing could
    // ever populate its confirmed set -- so a user saying yes changed nothing
    // and the agent was refused again.
    dom.window.document.body.innerHTML = '<button id="d">Delete account</button>';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    let clicks = 0;
    dom.window.document.getElementById("d")!.addEventListener("click", () => {
      clicks += 1;
    });
    const offered: ConfirmRequest[] = [];
    let api: { confirm: (key: string) => void } | null = null;
    const h = mount(room, {
      enabled: true,
      denylist: ["delete"],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
      onRefusal: (_d, c) => {
        if (c) offered.push(c);
      },
      onReady: (a) => {
        api = a;
      },
    });
    await flushMicrotasks();

    const first = await callRpc(handlers, RPC_CLICK, {
      ref: "ref_1",
      expect: "Delete account",
    });
    assert.equal(first.ok, false);
    assert.equal(clicks, 0);

    // The user presses "Allow once".
    assert.ok(api, "hook should expose confirm()");
    api!.confirm(offered[0].key);

    const second = await callRpc(handlers, RPC_CLICK, {
      ref: "ref_1",
      expect: "Delete account",
    });
    assert.equal(second.ok, true, "the approved click must go through");
    assert.equal(clicks, 1);

    // And the approval is spent -- it was for one press, not for the session.
    const third = await callRpc(handlers, RPC_CLICK, {
      ref: "ref_1",
      expect: "Delete account",
    });
    assert.equal(third.ok, false, "a second press must be asked about again");
    assert.equal(clicks, 1);
    h.unmount();
  });
});
