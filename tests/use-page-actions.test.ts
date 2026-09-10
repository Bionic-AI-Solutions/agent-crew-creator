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
  reassertControlBar?: (force?: boolean) => "top-layer" | "unsupported" | "failed";
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
    reassertControlBar: props.reassertControlBar,
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

/**
 * Read the page the way the agent does, and hand back its listing.
 *
 * Refs identify an element rather than a position now, so they only exist
 * once something has captured the page. That is exactly the agent's own
 * sequence -- read, then act -- and it means these tests stop hardcoding
 * "ref_1" and use the ref the listing actually gave them.
 */
async function readListing(handlers: Map<string, (d: any) => Promise<string>>) {
  const page = await callRpc(handlers, RPC_READ_PAGE, {});
  return page.elements as Array<{ ref: string; name: string; role: string }>;
}

/** The ref the listing gave for the control with this name. */
function refNamed(
  elements: Array<{ ref: string; name: string }>,
  name: string,
): string {
  const hit = elements.find((e) => e.name === name);
  assert.ok(hit, `listing has no control named ${JSON.stringify(name)}`);
  return hit!.ref;
}

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

  /**
   * Install an IntersectionObserver of a given generation.
   *
   * `version` 2 reports `isVisible`; version 1 does NOT -- and that is the
   * shape Firefox and Safari actually ship, which is the case worth pinning.
   */
  function installObserver(
    version: 1 | 2,
    isVisible = true,
    opts: { keepReporting?: boolean; recoverAfterMs?: number } = {},
  ) {
    const previousObserver = (globalThis as any).IntersectionObserver;
    const previousEntry = (globalThis as any).IntersectionObserverEntry;

    class FakeEntry {}
    if (version === 2) (FakeEntry.prototype as any).isVisible = true;

    (globalThis as any).IntersectionObserverEntry = FakeEntry;
    (globalThis as any).IntersectionObserver = class {
      constructor(private cb: (entries: unknown[]) => void, _opts?: unknown) {}
      observe() {
        this.emit();
        // Simulates a re-assertion that WORKED: the browser notices the bar
        // is on top again and says so.
        if (opts.recoverAfterMs !== undefined) {
          setTimeout(() => {
            this.cb([{ isIntersecting: true, isVisible: true }]);
          }, opts.recoverAfterMs);
        }
        // Keeps answering, so a report can post-date a re-assertion the way a
        // real overlay's would.
        if (opts.keepReporting) this.timer = setInterval(() => this.emit(), 5);
      }
      private timer: any = null;
      emit() {
        this.cb([
          version === 2
            ? { isIntersecting: true, isVisible }
            : // A v1 entry simply has no isVisible. Unknown dictionary
              // members are ignored per WebIDL, so nothing throws here
              // either -- which is exactly why this needed detecting.
              { isIntersecting: true },
        ]);
      }
      disconnect() {
        if (this.timer) clearInterval(this.timer);
      }
      unobserve() {}
    };
    return () => {
      (globalThis as any).IntersectionObserver = previousObserver;
      (globalThis as any).IntersectionObserverEntry = previousEntry;
    };
  }

  async function clickThrough(bar: HTMLElement, inTopLayer = true) {
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
      // jsdom has no popover support, so the top layer is reported directly.
      // It matters: outside the top layer the observer's answer is not acted
      // on at all, because there it cannot be told apart from a transparent
      // portal root.
      reassertControlBar: () => (inTopLayer ? "top-layer" : "unsupported"),
      onControlRevoked: (d) => revoked.push(d),
    });
    await flushMicrotasks();
    const ref = refNamed(await readListing(handlers), "Continue");
    const res = await callRpc(handlers, RPC_CLICK, { ref, expect: "Continue" });
    void h;
    return { res, clicked, revoked };
  }

  test("a first covered report re-asserts rather than revoking", async () => {
    // The browser reports our bar as not visible whenever ANY other top-layer
    // element exists -- a cookie dialog in the far corner does it, overlap or
    // not. Re-asserting puts us back on top and it reports visible again, so
    // a first report is a cue to re-assert, never a reason to stop.
    dom.window.document.body.innerHTML = '<button id="go">Continue</button>';
    const bar = makeVisibleBar();
    const restore = installObserver(2, false);
    const forced: boolean[] = [];
    try {
      const { room, handlers } = makeFakeRoom();
      const h = mount(room, {
        enabled: true,
        denylist: [],
        allowedOrigins: [ORIGIN],
        getControlBar: () => bar,
        reassertControlBar: (force) => {
          forced.push(!!force);
          return "top-layer";
        },
      });
      await flushMicrotasks();
      const ref = refNamed(await readListing(handlers), "Continue");
      const res = await callRpc(handlers, RPC_CLICK, { ref, expect: "Continue" });

      assert.equal(res.ok, true, JSON.stringify(res));
      // And it was a REAL re-assertion. showPopover on an already-open
      // popover is a silent no-op, so without force the bar stays underneath
      // whatever opened over it, forever.
      assert.ok(
        forced.some((f) => f === true),
        "a covered report must force a hide-then-show re-assertion",
      );
      void h;
    } finally {
      restore();
    }
  });

  test("a report that survives re-assertion does revoke", async () => {
    // The observer keeps saying covered even after we have put ourselves back
    // on top: something really is there.
    dom.window.document.body.innerHTML = '<button id="go">Continue</button>';
    const bar = makeVisibleBar();
    const restore = installObserver(2, false, { keepReporting: true });
    try {
      const { room, handlers } = makeFakeRoom();
      let clicks = 0;
      dom.window.document.getElementById("go")!.addEventListener("click", () => {
        clicks += 1;
      });
      const revoked: string[] = [];
      const h = mount(room, {
        enabled: true,
        denylist: [],
        allowedOrigins: [ORIGIN],
        getControlBar: () => bar,
        reassertControlBar: () => "top-layer",
        onControlRevoked: (d) => revoked.push(d),
      });
      await flushMicrotasks();
      const ref = refNamed(await readListing(handlers), "Continue");

      // The first attempt re-asserts and goes through -- that is the cue
      // being acted on, not ignored.
      const first = await callRpc(handlers, RPC_CLICK, { ref, expect: "Continue" });
      assert.equal(first.ok, true, JSON.stringify(first));

      // The observer keeps saying covered, so the next reading post-dates the
      // re-assertion: something really is there.
      await delay(30);
      const second = await callRpc(handlers, RPC_CLICK, { ref, expect: "Continue" });
      assert.equal(second.ok, false, JSON.stringify(second));
      assert.equal(second.reason, "control_ui_obscured");
      assert.equal(clicks, 1, "only the first, pre-confirmation click landed");
      assert.ok(revoked.length > 0);
      void h;
    } finally {
      restore();
    }
  });

  test("a re-assertion is given time to be confirmed", async () => {
    // The silence rule must not fire while the answer is still in flight.
    // The grace period is what separates "the re-assertion did not work" from
    // "the browser has not got round to saying so yet".
    dom.window.document.body.innerHTML = '<button id="go">Continue</button>';
    const bar = makeVisibleBar();
    const restore = installObserver(2, false);
    try {
      const { room, handlers } = makeFakeRoom();
      let clicks = 0;
      dom.window.document.getElementById("go")!.addEventListener("click", () => {
        clicks += 1;
      });
      const h = mount(room, {
        enabled: true,
        denylist: [],
        allowedOrigins: [ORIGIN],
        getControlBar: () => bar,
        reassertControlBar: () => "top-layer",
      });
      await flushMicrotasks();
      const ref = refNamed(await readListing(handlers), "Continue");

      // Re-asserts, goes through.
      assert.equal(
        (await callRpc(handlers, RPC_CLICK, { ref, expect: "Continue" })).ok,
        true,
      );
      // The next one lands inside the grace window (a click's own settle is
      // 350ms, the grace is 400ms), so silence must not be read as failure.
      assert.equal(
        (await callRpc(handlers, RPC_CLICK, { ref, expect: "Continue" })).ok,
        true,
        "still inside the grace window",
      );
      assert.equal(clicks, 2);
      void h;
    } finally {
      restore();
    }
  });

  test("a cover that goes silent still revokes", async () => {
    // The observer reports TRANSITIONS. A page that re-covers the bar faster
    // than the observer samples (~150ms) produces no further callbacks at
    // all, so waiting for a fresh "covered" report waits forever -- measured
    // at a plain setInterval(50): the Stop button stayed unreachable for
    // eight seconds with zero revocations while the agent kept clicking.
    // What settles it is the absence of a VISIBLE report after re-asserting.
    dom.window.document.body.innerHTML = '<button id="go">Continue</button>';
    const bar = makeVisibleBar();
    // Reports covered exactly once, then goes quiet -- the attack's signature.
    const restore = installObserver(2, false);
    try {
      const { room, handlers } = makeFakeRoom();
      let clicks = 0;
      dom.window.document.getElementById("go")!.addEventListener("click", () => {
        clicks += 1;
      });
      const h = mount(room, {
        enabled: true,
        denylist: [],
        allowedOrigins: [ORIGIN],
        getControlBar: () => bar,
        reassertControlBar: () => "top-layer",
      });
      await flushMicrotasks();
      const ref = refNamed(await readListing(handlers), "Continue");

      // First attempt re-asserts and goes through.
      const first = await callRpc(handlers, RPC_CLICK, { ref, expect: "Continue" });
      assert.equal(first.ok, true, JSON.stringify(first));

      // Nothing more is heard from the observer. Once the grace period has
      // passed with no confirmation that the re-assertion worked, that
      // silence is itself the answer.
      await delay(500);
      const second = await callRpc(handlers, RPC_CLICK, { ref, expect: "Continue" });
      assert.equal(second.ok, false, JSON.stringify(second));
      assert.equal(second.reason, "control_ui_obscured");
      assert.equal(clicks, 1);
      void h;
    } finally {
      restore();
    }
  });

  test("failing to reach the top layer where it exists revokes", async () => {
    // A page can remove the popover attribute, which made showPopover throw.
    // The previous version read that as "no top layer here" and relaxed --
    // turning off the only check that sees a pointer-events:none scrim. An
    // anomaly is not a licence to check less.
    dom.window.document.body.innerHTML = '<button id="go">Continue</button>';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    const h = mount(room, {
      enabled: true,
      denylist: [],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
      reassertControlBar: () => "failed",
    });
    await flushMicrotasks();
    const ref = refNamed(await readListing(handlers), "Continue");
    const res = await callRpc(handlers, RPC_CLICK, { ref, expect: "Continue" });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "control_ui_detached");
    void h;
  });

  test("outside the top layer, a covered report does not revoke", async () => {
    // Where the top layer is unavailable the observer cannot be told apart
    // from a transparent portal root, so acting on it would revoke control on
    // ordinary pages. It is left alone instead.
    dom.window.document.body.innerHTML = '<button id="go">Continue</button>';
    const bar = makeVisibleBar();
    const restore = installObserver(2, false);
    try {
      const { res, clicked } = await clickThrough(bar, false);
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(clicked, true);
    } finally {
      restore();
    }
  });

  test("a v1 IntersectionObserver does not revoke control", async () => {
    // THE case that ships on Firefox and Safari. They have v1; WebIDL says an
    // unknown dictionary member is ignored, so { trackVisibility: true }
    // constructs without throwing and entries simply lack isVisible.
    // `!undefined` is true, so reading it as a verdict said "covered" on a
    // pristine page and revoked control on every page in those browsers, one
    // second after the user pressed "Let it act".
    dom.window.document.body.innerHTML = '<button id="go">Continue</button>';
    const bar = makeVisibleBar();

    // A full-bleed opaque background that overlaps the bar's rect while
    // painting BEHIND it -- a hero image or background video, entirely
    // ordinary. It matters here: corroboration alone cannot tell behind from
    // in front, so if a v1 entry were read as "covered", corroboration would
    // find this and revoke. Without it the bug hides, because a page with
    // nothing opaque on it survives either way.
    const backdrop = dom.window.document.createElement("div");
    backdrop.id = "backdrop";
    backdrop.style.cssText = "background: rgb(20,20,20)";
    dom.window.document.body.appendChild(backdrop);
    (backdrop as any).getBoundingClientRect = () => ({
      width: 1024, height: 768, top: 0, left: 0, bottom: 768, right: 1024,
    });

    const restore = installObserver(1);
    try {
      const { res, clicked } = await clickThrough(bar);
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(clicked, true);
    } finally {
      restore();
      backdrop.remove();
    }
  });

  test("no IntersectionObserver at all does not revoke control", async () => {
    dom.window.document.body.innerHTML = '<button id="go">Continue</button>';
    const bar = makeVisibleBar();
    const previous = (globalThis as any).IntersectionObserver;
    delete (globalThis as any).IntersectionObserver;
    try {
      const { res } = await clickThrough(bar);
      assert.equal(res.ok, true, JSON.stringify(res));
    } finally {
      (globalThis as any).IntersectionObserver = previous;
    }
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

    const ref = refNamed(await readListing(handlers), "Continue");
    const res = await callRpc(handlers, RPC_CLICK, { ref, expect: "Continue" });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(clicked, true);
    h.unmount();
  });
});

describe("usePageActions — a ref must still be what the agent named", () => {
  test("inserting a control above the target does not move the target's ref", async () => {
    // This used to click the intruder: refs were positional and resolved by
    // re-walking the DOM, so anything inserted above shifted the ref down
    // onto its neighbour.
    dom.window.document.body.innerHTML = '<button id="a">Details</button>';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    const h = mount(room, {
      enabled: true,
      denylist: [],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
    });
    await flushMicrotasks();

    const ref = refNamed(await readListing(handlers), "Details");

    let detailsClicked = false;
    dom.window.document.getElementById("a")!.addEventListener("click", () => {
      detailsClicked = true;
    });
    const intruder = dom.window.document.createElement("button");
    intruder.textContent = "Unsubscribe from everything";
    let intruderClicked = false;
    intruder.addEventListener("click", () => {
      intruderClicked = true;
    });
    dom.window.document.body.insertBefore(
      intruder,
      dom.window.document.getElementById("a"),
    );

    const res = await callRpc(handlers, RPC_CLICK, { ref, expect: "Details" });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(detailsClicked, true, "the named control must be the one pressed");
    assert.equal(intruderClicked, false, "the intruder must never be pressed");
    void h;
  });

  test("two controls with the same name are told apart", async () => {
    // The case an expected-name check alone cannot catch, and the one real UI
    // is full of: a table where every row has its own "Edit".
    dom.window.document.body.innerHTML =
      '<div id="rows">' +
      '<div><button data-row="A" aria-label="Edit">Edit</button></div>' +
      '<div><button data-row="B" aria-label="Edit">Edit</button></div>' +
      "</div>";
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    const h = mount(room, {
      enabled: true,
      denylist: [],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
    });
    await flushMicrotasks();

    const listing = await readListing(handlers);
    const firstEdit = listing.filter((e) => e.name === "Edit")[0].ref;

    const pressed: string[] = [];
    for (const el of Array.from(dom.window.document.querySelectorAll("[data-row]"))) {
      el.addEventListener("click", () =>
        pressed.push(el.getAttribute("data-row")!),
      );
    }

    // Row B moves above row A. Both are still called "Edit".
    const rows = dom.window.document.getElementById("rows")!;
    rows.insertBefore(rows.children[1], rows.children[0]);

    const res = await callRpc(handlers, RPC_CLICK, { ref: firstEdit, expect: "Edit" });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(pressed, ["A"], "must press row A's Edit, not whichever is now first");
    void h;
  });

  test("a ref whose control is gone is refused, not silently retargeted", async () => {
    dom.window.document.body.innerHTML = '<button id="a">Details</button>';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    const h = mount(room, {
      enabled: true,
      denylist: [],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
    });
    await flushMicrotasks();

    const ref = refNamed(await readListing(handlers), "Details");

    // The control is replaced by a different one in the same place. Only that
    // button is swapped -- resetting body.innerHTML would take the control bar
    // with it and revoke control before the ref was ever consulted.
    const old = dom.window.document.getElementById("a")!;
    const replacement = dom.window.document.createElement("button");
    replacement.id = "b";
    replacement.textContent = "Unsubscribe";
    old.parentNode!.replaceChild(replacement, old);
    let replacementClicked = false;
    dom.window.document.getElementById("b")!.addEventListener("click", () => {
      replacementClicked = true;
    });

    const res = await callRpc(handlers, RPC_CLICK, { ref, expect: "Details" });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "ref_not_found");
    assert.equal(replacementClicked, false);
    // The refusal carries the current listing so the agent can recover.
    assert.ok(Array.isArray(res.elements) && res.elements.length > 0);
    void h;
  });

  test("a control renamed since the listing is refused", async () => {
    // The other half of the identity check: the element is the same node, but
    // it no longer says what the agent was told it says.
    dom.window.document.body.innerHTML = '<button id="a">Save draft</button>';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    const h = mount(room, {
      enabled: true,
      denylist: [],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
    });
    await flushMicrotasks();

    const ref = refNamed(await readListing(handlers), "Save draft");
    const button = dom.window.document.getElementById("a")!;
    let clicked = false;
    button.addEventListener("click", () => {
      clicked = true;
    });
    button.textContent = "Publish to everyone";

    const res = await callRpc(handlers, RPC_CLICK, { ref, expect: "Save draft" });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "ref_moved");
    assert.equal(clicked, false);
    void h;
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

    const ref = refNamed(await readListing(handlers), "Details");
    const res = await callRpc(handlers, RPC_CLICK, { ref });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "ref_moved");
    assert.equal(clicked, false);
    h.unmount();
  });
});

describe("usePageActions — controls with no name", () => {
  test("an icon-only button can still be clicked", async () => {
    // format_for_model shows the model "(no name)" for an unnamed control,
    // the model copies what it is shown, and the browser compared it against
    // "" -- so every hamburger, close X and send arrow was refused forever
    // with "the page changed", and re-reading produced the identical block.
    dom.window.document.body.innerHTML = '<button id="x"><svg></svg></button>';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    let clicked = false;
    dom.window.document.getElementById("x")!.addEventListener("click", () => {
      clicked = true;
    });
    const h = mount(room, {
      enabled: true,
      denylist: [],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
    });
    await flushMicrotasks();

    const listing = await readListing(handlers);
    const unnamed = listing.find((e) => e.name === "");
    assert.ok(unnamed, "an unnamed control should be listed");

    const res = await callRpc(handlers, RPC_CLICK, {
      ref: unnamed!.ref,
      expect: "(no name)",
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(clicked, true);
    void h;
  });

  test("a password field is refused as a password field, not as a moved ref", async () => {
    // capturePage lists a password field with an empty name so nothing about
    // its contents leaves the browser, but the act-time name was computed
    // separately and came back as its label -- so the mismatch fired first
    // and the password rule, which is the one that must never be reachable
    // around, was never reached at all.
    dom.window.document.body.innerHTML =
      '<input id="p" type="password" aria-label="Password" />';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    const h = mount(room, {
      enabled: true,
      denylist: [],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
    });
    await flushMicrotasks();

    const listing = await readListing(handlers);
    const field = listing.find((e) => e.role === "password");
    assert.ok(field, "the password box should be listed");
    assert.equal(field!.name, "", "and listed with no name");

    const res = await callRpc(handlers, RPC_TYPE_TEXT, {
      ref: field!.ref,
      text: "hunter2",
      expect: "(no name)",
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "password_field");
    void h;
  });
});

describe("usePageActions — a password field's label never leaves the browser", () => {
  test("no reply, refusal or summary ever contains it", async () => {
    // A password field is listed with an empty name so nothing about it
    // leaves the browser. That held in capturePage but not at act time, where
    // the name was computed by a second, different definition -- so this
    // sweeps every string that goes back to the model rather than trusting
    // that one call site is right.
    const SECRET_LABEL = "Passphrase for the vault";
    dom.window.document.body.innerHTML =
      `<input id="p" type="password" aria-label="${SECRET_LABEL}" />` +
      '<button id="ok">Continue</button>';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();

    const said: string[] = [];
    const h = mount(room, {
      enabled: true,
      denylist: [],
      allowedOrigins: [ORIGIN],
      getControlBar: () => bar,
      onRefusal: (d) => said.push(d),
      onAction: (sMsg) => said.push(sMsg),
    });
    await flushMicrotasks();

    const listing = await readListing(handlers);
    // A password input gets its own role, so it is unmistakable in a listing.
    const field = listing.find((e) => e.role === "password")!;
    assert.ok(field, "the password box should be listed");
    assert.equal(field.name, "", "and must be listed with no name at all");

    const replies: string[] = [JSON.stringify(listing)];
    replies.push(
      JSON.stringify(
        await callRpc(handlers, RPC_TYPE_TEXT, {
          ref: field.ref,
          text: "hunter2",
          expect: "(no name)",
        }),
      ),
    );
    replies.push(
      JSON.stringify(
        await callRpc(handlers, RPC_CLICK, { ref: field.ref, expect: "(no name)" }),
      ),
    );
    // And with a WRONG expect, which takes the ref_moved path that quotes the
    // live name back at the agent.
    replies.push(
      JSON.stringify(
        await callRpc(handlers, RPC_CLICK, { ref: field.ref, expect: "something else" }),
      ),
    );

    for (const text of [...replies, ...said]) {
      assert.ok(
        !text.includes(SECRET_LABEL),
        `a password field's label reached the model in: ${text.slice(0, 200)}`,
      );
    }
    void h;
  });
});

describe("usePageActions — what the agent is told about the listing", () => {
  test("a plain read carries no changed flag", async () => {
    // read_page used to send changed:false, which the agent side rendered as
    // "NOTHING CHANGED. Say so; do not move on" -- on the first read of every
    // conversation.
    dom.window.document.body.innerHTML = '<button id="go">Continue</button>';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    const h = mount(room, {
      enabled: true, denylist: [], allowedOrigins: [ORIGIN], getControlBar: () => bar,
    });
    await flushMicrotasks();
    const page = await callRpc(handlers, RPC_READ_PAGE, {});
    assert.equal(page.ok, true);
    assert.ok(!("changed" in page), `a read is not an action: ${JSON.stringify(page)}`);
    void h;
  });

  test("truncation reaches the wire", async () => {
    // Computed by capturePage and then dropped on the floor here, so on the
    // path the agent actually works through, a 200-line listing always
    // looked complete.
    dom.window.document.body.innerHTML = Array.from(
      { length: 230 },
      (_, i) => `<button>B${i}</button>`,
    ).join("");
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    const h = mount(room, {
      enabled: true, denylist: [], allowedOrigins: [ORIGIN], getControlBar: () => bar,
    });
    await flushMicrotasks();
    const page = await callRpc(handlers, RPC_READ_PAGE, {});
    assert.ok(
      (page.truncated ?? 0) + (page.unexamined ?? 0) > 0,
      `the agent must be told the listing is partial: ${JSON.stringify(Object.keys(page))}`,
    );
    void h;
  });

  test("a capture that throws is reported as unreadable, not as an empty page", async () => {
    dom.window.document.body.innerHTML = '<button id="go">Continue</button>';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    const h = mount(room, {
      enabled: true, denylist: [], allowedOrigins: [ORIGIN], getControlBar: () => bar,
    });
    await flushMicrotasks();
    const original = dom.window.document.querySelectorAll;
    (dom.window.document as any).querySelectorAll = () => {
      throw new Error("the page refuses to be read");
    };
    try {
      const page = await callRpc(handlers, RPC_READ_PAGE, {});
      assert.equal(page.ok, false);
      assert.equal(page.reason, "read_failed");
    } finally {
      (dom.window.document as any).querySelectorAll = original;
    }
    void h;
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

    const ref = refNamed(await readListing(handlers), "Message body");
    const res = await callRpc(handlers, RPC_TYPE_TEXT, {
      ref,
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

    const ref = refNamed(await readListing(handlers), "Search");
    const res = await callRpc(handlers, RPC_TYPE_TEXT, {
      ref,
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

    const ref = refNamed(await readListing(handlers), "Delete account");
    const res = await callRpc(handlers, RPC_CLICK, { ref, expect: "Delete account" });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "awaiting_user_confirmation");
    assert.equal(clicked, false);
    assert.equal(offered.length, 1, "the user must be offered the choice");
    h.unmount();
  });

  test("one approval cannot be spent twice by concurrent calls", async () => {
    // The approval used to be spent AFTER the click and its 350ms settle,
    // leaving a window it was still live in. The agent's own runtime opens
    // that window: livekit-agents runs the function calls in one LLM
    // response as concurrent tasks, and these tools allow duplicates -- so
    // two identical click calls overlap and one approval pressed "Pay now"
    // twice.
    dom.window.document.body.innerHTML = '<button id="d">Pay now</button>';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    let presses = 0;
    dom.window.document.getElementById("d")!.addEventListener("click", () => {
      presses += 1;
    });
    const offered: ConfirmRequest[] = [];
    let api: { confirm: (key: string) => void } | null = null;
    const h = mount(room, {
      enabled: true,
      denylist: ["pay"],
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

    const ref = refNamed(await readListing(handlers), "Pay now");
    assert.equal((await callRpc(handlers, RPC_CLICK, { ref, expect: "Pay now" })).ok, false);
    assert.ok(api);
    api!.confirm(offered[0].key);

    // Both dispatched before either settles, exactly as the runtime does.
    const [a, b] = await Promise.all([
      callRpc(handlers, RPC_CLICK, { ref, expect: "Pay now" }),
      callRpc(handlers, RPC_CLICK, { ref, expect: "Pay now" }),
    ]);
    assert.equal(presses, 1, "one approval, one press");
    assert.equal([a.ok, b.ok].filter(Boolean).length, 1, "exactly one may succeed");
    h.unmount();
  });

  test("an approval is spent even if the press itself fails", async () => {
    // If el.click() threw, the delete never ran and the approval survived
    // for a later, unapproved click.
    dom.window.document.body.innerHTML = '<button id="d">Pay now</button>';
    const bar = makeVisibleBar();
    const { room, handlers } = makeFakeRoom();
    const target = dom.window.document.getElementById("d")! as any;
    target.click = () => {
      throw new Error("the page refuses to be clicked");
    };
    const offered: ConfirmRequest[] = [];
    let api: { confirm: (key: string) => void } | null = null;
    const h = mount(room, {
      enabled: true,
      denylist: ["pay"],
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

    const ref = refNamed(await readListing(handlers), "Pay now");
    assert.equal((await callRpc(handlers, RPC_CLICK, { ref, expect: "Pay now" })).ok, false);
    api!.confirm(offered[0].key);

    // The approved attempt throws out of the handler.
    await handlers
      .get(RPC_CLICK)!({ payload: JSON.stringify({ ref, expect: "Pay now" }) })
      .then(
        () => {},
        () => {},
      );

    // The approval must be gone.
    const after = await callRpc(handlers, RPC_CLICK, { ref, expect: "Pay now" });
    assert.equal(after.ok, false);
    assert.equal(after.reason, "awaiting_user_confirmation");
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

    const ref = refNamed(await readListing(handlers), "Delete account");
    const first = await callRpc(handlers, RPC_CLICK, { ref, expect: "Delete account" });
    assert.equal(first.ok, false);
    assert.equal(clicks, 0);

    // The user presses "Allow once".
    assert.ok(api, "hook should expose confirm()");
    api!.confirm(offered[0].key);

    const second = await callRpc(handlers, RPC_CLICK, { ref, expect: "Delete account" });
    assert.equal(second.ok, true, "the approved click must go through");
    assert.equal(clicks, 1);

    // And the approval is spent -- it was for one press, not for the session.
    const third = await callRpc(handlers, RPC_CLICK, { ref, expect: "Delete account" });
    assert.equal(third.ok, false, "a second press must be asked about again");
    assert.equal(clicks, 1);
    h.unmount();
  });
});
