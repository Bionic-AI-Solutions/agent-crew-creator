/**
 * Tests for controlUiVisibility — the check that decides whether the agent is
 * still allowed to act on the page.
 *
 * The adversarial review's blocking finding was that a single ordinary CSS
 * rule on the host page (`#bionic-embed-wrapper { display: none !important }`)
 * hid the control banner and the Stop button while every RPC method stayed
 * registered and working. These pin the checks that now revoke control
 * instead, including the ones a style-only check cannot see: an ancestor's
 * opacity, an overlay painted on top, and the element being detached.
 *
 * Run: npx tsx --test tests/control-visibility.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  controlUiVisibility,
  outermostHost,
  filterHides,
} from "../client/src/embed/controlVisibility.ts";

const VIEWPORT = { innerWidth: 1024, innerHeight: 768 };

/** A bar sitting comfortably on screen unless a test says otherwise. */
const GOOD_RECT = { width: 300, height: 32, top: 10, left: 10, bottom: 42, right: 310 };

const GOOD_STYLE = {
  display: "block",
  visibility: "visible",
  opacity: "1",
  pointerEvents: "auto",
  filter: "none",
  position: "fixed",
  backgroundImage: "none",
  maskImage: "none",
  webkitMaskImage: "none",
  webkitMaskBoxImage: "none",
  clipPath: "none",
  contentVisibility: "visible",
  backgroundColor: "rgb(255, 255, 255)",
  backdropFilter: "none",
  zIndex: "0",
};

/** The real bar's stacking level, from embed-styles.css. */
const BAR_Z = "2147483647";

interface Scenario {
  /** Per-element style overrides, keyed by element id. */
  styles?: Record<string, Partial<typeof GOOD_STYLE>>;
  rect?: Partial<typeof GOOD_RECT>;
  /** What elementFromPoint returns; defaults to the wrapper (i.e. our UI). */
  hitTest?: (x: number, y: number) => Element | null;
}

/**
 * Builds the real shape this runs against: a light-DOM wrapper in the host
 * page, an open shadow root, and the bar inside it.
 */
function build(scenario: Scenario = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="wrapper"></div></body></html>`,
    { url: "https://host.example/app" },
  );
  const doc = dom.window.document;
  const wrapper = doc.getElementById("wrapper")!;
  const shadow = wrapper.attachShadow({ mode: "open" });
  const bar = doc.createElement("div");
  bar.id = "bar";
  shadow.appendChild(bar);

  const rect = { ...GOOD_RECT, ...(scenario.rect ?? {}) };
  (bar as any).getBoundingClientRect = () => rect;

  const win = {
    ...VIEWPORT,
    getComputedStyle: (el: Element) => ({
      ...GOOD_STYLE,
      ...((el as HTMLElement).id === "bar" ? { zIndex: BAR_Z } : {}),
      ...(scenario.styles?.[(el as HTMLElement).id ?? ""] ?? {}),
    }),
    document: {
      elementFromPoint: scenario.hitTest ?? (() => wrapper),
      querySelectorAll: (sel: string) => doc.querySelectorAll(sel),
    },
  };

  return { dom, doc, wrapper, shadow, bar, win };
}

describe("controlUiVisibility", () => {
  test("a normally rendered, unobstructed bar is visible", () => {
    const { bar, win } = build();
    assert.equal(controlUiVisibility(bar, win).visible, true);
  });

  test("display:none on the host page's wrapper revokes control", () => {
    // The exact reproduction from the review: the page styles the wrapper,
    // which shadow DOM does nothing to protect.
    const { bar, win } = build({ styles: { wrapper: { display: "none" } } });
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_hidden");
  });

  test("visibility:hidden on the wrapper revokes control", () => {
    // visibility INHERITS, so a real browser computes "hidden" on the bar too
    // unless something re-declares it. getComputedStyle is faked per element
    // here and models no inheritance, so both are set -- which is what
    // Chromium actually reports for this page.
    const { bar, win } = build({
      styles: { wrapper: { visibility: "hidden" }, bar: { visibility: "hidden" } },
    });
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_hidden");
  });

  test("an ancestor made transparent revokes control", () => {
    // opacity does not inherit, does not change the bar's own computed style,
    // and does not change its rect -- so only an ancestor walk catches it.
    const { bar, win } = build({ styles: { wrapper: { opacity: "0" } } });
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_transparent");
  });

  test("the bar itself made unclickable revokes control", () => {
    const { bar, win } = build({ styles: { bar: { pointerEvents: "none" } } });
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_unclickable");
  });

  test("a bar shrunk to nothing revokes control", () => {
    const { bar, win } = build({ rect: { width: 4, height: 2, right: 14, bottom: 12 } });
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_too_small");
  });

  test("a bar pushed off the viewport revokes control", () => {
    const { bar, win } = build({
      rect: { top: 900, bottom: 932, left: 10, right: 310 },
    });
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_off_screen");
  });

  test("an overlay painted on top revokes control", () => {
    // Every style is fine; something else simply owns those pixels.
    const { bar, doc, win } = build({
      hitTest: () => doc.createElement("div"),
    });
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_obscured");
  });

  test("a hit landing inside our own shadow content still counts as ours", () => {
    const { bar, win } = build({ hitTest: () => bar });
    assert.equal(controlUiVisibility(bar, win).visible, true);
  });

  test("a detached bar revokes control", () => {
    const { bar, wrapper, win } = build();
    wrapper.shadowRoot!.removeChild(bar);
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_detached");
  });

  test("a missing bar revokes control", () => {
    const { win } = build();
    const v = controlUiVisibility(null, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_missing");
  });

  test("fails closed when the page throws from getComputedStyle", () => {
    const { bar, wrapper, doc } = build();
    const win = {
      ...VIEWPORT,
      getComputedStyle: () => {
        throw new Error("nope");
      },
      document: { elementFromPoint: () => wrapper },
    } as any;
    void doc;
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_unreadable");
  });

  test("fails closed when elementFromPoint throws", () => {
    const { bar, win } = build({
      hitTest: () => {
        throw new Error("nope");
      },
    });
    assert.equal(controlUiVisibility(bar, win).visible, false);
  });

  test("a filter on the document element revokes control", () => {
    // `html { filter: opacity(0) }` renders the whole page blank while every
    // element's own computed filter stays "none" and no rect changes.
    // Confirmed in Chromium; the wrapper's inline reset cannot undo it.
    // The styles map is keyed by element id and documentElement has none, so
    // it is given one; getComputedStyle is consulted at call time, after this.
    const { bar, win, doc } = build({
      styles: { "root-html": { filter: "opacity(0)" } },
    });
    doc.documentElement.id = "root-html";
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_filtered");
  });

  test("an opaque pointer-events:none layer over the bar revokes control", () => {
    // elementFromPoint AND elementsFromPoint both skip pointer-events:none
    // (verified in Chromium), so hit testing reports a clean hit on the bar
    // underneath a layer the user plainly sees.
    const { bar, doc, wrapper, win } = build({
      styles: { veil: { pointerEvents: "none", backgroundColor: "rgb(255, 255, 255)", zIndex: BAR_Z } },
    });
    const veil = doc.createElement("div");
    veil.id = "veil";
    doc.body.appendChild(veil);
    (veil as any).getBoundingClientRect = () => ({
      width: 1024, height: 400, top: 0, left: 0, bottom: 400, right: 1024,
    });
    void wrapper;
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_obscured");
  });

  test("a transparent pointer-events:none layer does not revoke control", () => {
    // The false-positive direction: invisible click-through shims are
    // extremely common and must not break the feature.
    const { bar, doc, win } = build({
      styles: {
        veil: {
          pointerEvents: "none",
          backgroundColor: "rgba(0, 0, 0, 0)",
          backdropFilter: "none",
          zIndex: BAR_Z,
        },
      },
    });
    const veil = doc.createElement("div");
    veil.id = "veil";
    doc.body.appendChild(veil);
    (veil as any).getBoundingClientRect = () => ({
      width: 1024, height: 400, top: 0, left: 0, bottom: 400, right: 1024,
    });
    assert.equal(controlUiVisibility(bar, win).visible, true);
  });

  test("filterHides only flags filters that actually hide", () => {
    // Rejecting every non-none filter would revoke control on the many pages
    // that put a drop-shadow or a dark-mode invert on a container.
    for (const hiding of ["opacity(0)", "opacity(0%)", "opacity(.2)", "brightness(0)", "blur(12px)"]) {
      assert.equal(filterHides(hiding), true, hiding);
    }
    for (const harmless of [
      undefined, "none", "drop-shadow(0 1px 2px black)", "invert(1)",
      "saturate(1.5)", "hue-rotate(90deg)", "opacity(0.9)", "blur(2px)",
    ]) {
      assert.equal(filterHides(harmless), false, String(harmless));
    }
  });

  test("a mask on an ancestor revokes control", () => {
    // Same class as filter: an ancestor compositing effect a descendant
    // cannot undo. `mask-image: linear-gradient(transparent,transparent)`
    // renders the bar to zero pixels with its own style untouched.
    for (const prop of ["maskImage", "webkitMaskImage", "webkitMaskBoxImage"] as const) {
      const { bar, win } = build({
        styles: { wrapper: { [prop]: "linear-gradient(transparent, transparent)" } },
      });
      const v = controlUiVisibility(bar, win);
      assert.equal(v.visible, false, prop);
      assert.equal(v.reason, "control_ui_filtered", prop);
    }
  });

  test("clip-path on an ancestor revokes control", () => {
    const { bar, win } = build({ styles: { wrapper: { clipPath: "inset(100%)" } } });
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_filtered");
  });

  test("content-visibility:hidden on an ancestor revokes control", () => {
    const { bar, win } = build({ styles: { wrapper: { contentVisibility: "hidden" } } });
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_filtered");
  });

  test("visibility:hidden on an ancestor does not revoke when the bar re-enables it", () => {
    // `body { visibility: hidden }` is a standard anti-FOUC pattern, and the
    // wrapper's inline reset re-declares visibility:visible, so the bar
    // really does render. Revoking there killed control on innocent pages.
    const { bar, win } = build({
      styles: { wrapper: { visibility: "hidden" }, bar: { visibility: "visible" } },
    });
    assert.equal(controlUiVisibility(bar, win).visible, true);
  });

  test("visibility:hidden on the bar itself still revokes", () => {
    const { bar, win } = build({ styles: { bar: { visibility: "hidden" } } });
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_hidden");
  });

  test("a gradient scrim over the bar revokes control", () => {
    // How real UIs build fades and backdrops. Its background-COLOR is
    // transparent, so a colour-only check sailed straight through it.
    const { bar, doc, win } = build({
      styles: {
        veil: {
          pointerEvents: "none",
          backgroundColor: "rgba(0, 0, 0, 0)",
          backgroundImage: "linear-gradient(rgb(255,255,255), rgb(255,255,255))",
          zIndex: BAR_Z,
        },
      },
    });
    const veil = doc.createElement("div");
    veil.id = "veil";
    doc.body.appendChild(veil);
    (veil as any).getBoundingClientRect = () => ({
      width: 1024, height: 400, top: 0, left: 0, bottom: 400, right: 1024,
    });
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_obscured");
  });

  test("an overlay appended last on a large page is still found", () => {
    // querySelectorAll returns document order and the scan is capped, so
    // taking the first N never reached a modal backdrop -- portals append
    // theirs at the end of <body>, which is where the cap had already
    // stopped. The scan runs backwards for exactly this.
    const { bar, doc, win } = build({
      styles: { veil: { pointerEvents: "none", backgroundColor: "rgb(255, 255, 255)", zIndex: BAR_Z } },
    });
    for (let i = 0; i < 5000; i++) {
      const filler = doc.createElement("span");
      (filler as any).getBoundingClientRect = () => ({
        width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0,
      });
      doc.body.appendChild(filler);
    }
    const veil = doc.createElement("div");
    veil.id = "veil";
    doc.body.appendChild(veil);
    (veil as any).getBoundingClientRect = () => ({
      width: 1024, height: 400, top: 0, left: 0, bottom: 400, right: 1024,
    });
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_obscured");
  });

  test("the cheap heartbeat skips the overlay scan; a full check does not", () => {
    // The scan reads a rect for thousands of elements -- 37ms at 4x CPU
    // throttle on a 12k-element page, which is two dropped frames every
    // second if it runs on the 1s heartbeat. Actions run it; the heartbeat
    // does not, and an action cannot slip past because it checks for itself.
    const { bar, doc, win } = build({
      styles: { veil: { pointerEvents: "none", backgroundColor: "rgb(255, 255, 255)", zIndex: BAR_Z } },
    });
    const veil = doc.createElement("div");
    veil.id = "veil";
    doc.body.appendChild(veil);
    (veil as any).getBoundingClientRect = () => ({
      width: 1024, height: 400, top: 0, left: 0, bottom: 400, right: 1024,
    });

    assert.equal(
      controlUiVisibility(bar, win, { scanOverlays: false }).visible,
      true,
      "the heartbeat does not pay for the scan",
    );
    const full = controlUiVisibility(bar, win, { scanOverlays: true });
    assert.equal(full.visible, false, "an action does");
    assert.equal(full.reason, "control_ui_obscured");

    // Default is the full check, so a caller that forgets is safe.
    assert.equal(controlUiVisibility(bar, win).visible, false);
  });

  test("the cheap heartbeat still catches everything done by styling", () => {
    // What the heartbeat gives up is narrow: only a pointer-events:none
    // scrim. Everything that hides the bar by styling it is still caught
    // without the scan.
    for (const styles of [
      { wrapper: { display: "none" } },
      { bar: { visibility: "hidden" } },
      { wrapper: { opacity: "0" } },
      { wrapper: { filter: "opacity(0)" } },
      { wrapper: { clipPath: "inset(100%)" } },
      { wrapper: { contentVisibility: "hidden" } },
    ]) {
      const { bar, win } = build({ styles });
      assert.equal(
        controlUiVisibility(bar, win, { scanOverlays: false }).visible,
        false,
        JSON.stringify(styles),
      );
    }
  });

  test("a scrim inside another component's open shadow root revokes control", () => {
    // querySelectorAll("*") does not cross a shadow boundary, so this was
    // invisible to the scan -- and it is not exotic: design-system modals put
    // their backdrop inside a shadow root as a matter of course. Reproduced
    // in Chromium (bar rendered 0 pixels while the check said visible).
    const { bar, doc, win } = build({
      styles: { veil: { pointerEvents: "none", backgroundColor: "rgb(255, 255, 255)", zIndex: BAR_Z } },
    });
    const other = doc.createElement("div");
    doc.body.appendChild(other);
    const otherShadow = other.attachShadow({ mode: "open" });
    const veil = doc.createElement("div");
    veil.id = "veil";
    otherShadow.appendChild(veil);
    (veil as any).getBoundingClientRect = () => ({
      width: 1024, height: 400, top: 0, left: 0, bottom: 400, right: 1024,
    });

    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_obscured");
  });

  test("an iframe laid over the bar revokes control", () => {
    // An <iframe> reports background-color rgba(0,0,0,0) -- the white a
    // person sees comes from the document inside it, which we cannot inspect
    // and, cross-origin, are not allowed to. Every background check said
    // "transparent" while it covered the bar completely. Consent banners and
    // chat widgets are built exactly like this.
    const { bar, doc, win } = build({
      styles: {
        veil: {
          pointerEvents: "none",
          backgroundColor: "rgba(0, 0, 0, 0)",
          backgroundImage: "none",
          zIndex: BAR_Z,
        },
      },
    });
    const frame = doc.createElement("iframe");
    frame.id = "veil";
    doc.body.appendChild(frame);
    (frame as any).getBoundingClientRect = () => ({
      width: 1024, height: 400, top: 0, left: 0, bottom: 400, right: 1024,
    });

    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_obscured");
  });

  test("a scrim inside a CLOSED shadow root is a known, documented limit", () => {
    // Pinned so the limit is visible in the suite rather than only in a
    // comment. No API traverses a closed shadow root -- that is what closed
    // means -- so this cannot be detected from inside the page, and reaching
    // it needs script on the host (attachShadow is not something CSS can do),
    // which is the residual risk the module header states plainly.
    //
    // If this test ever starts failing because the verdict became false,
    // that is good news and the assertion should be updated, not silenced.
    const { bar, doc, win } = build();
    const other = doc.createElement("div");
    doc.body.appendChild(other);
    const closed = other.attachShadow({ mode: "closed" });
    const veil = doc.createElement("div");
    closed.appendChild(veil);
    (veil as any).getBoundingClientRect = () => ({
      width: 1024, height: 400, top: 0, left: 0, bottom: 400, right: 1024,
    });

    assert.equal(
      controlUiVisibility(bar, win).visible,
      true,
      "documents the known limit; see the module header",
    );
  });

  test("an iframe that does not cover the bar does not revoke control", () => {
    // Replaced elements count as opaque wherever they overlap the bar, which
    // is why an iframe elsewhere on the page must not be treated as covering
    // it. A check that revokes on ordinary pages is as broken as one that
    // misses an attack; verified in Chromium alongside this.
    const { bar, doc, win } = build();
    const frame = doc.createElement("iframe");
    frame.id = "elsewhere";
    doc.body.appendChild(frame);
    (frame as any).getBoundingClientRect = () => ({
      width: 400, height: 200, top: 300, left: 0, bottom: 500, right: 400,
    });
    assert.equal(controlUiVisibility(bar, win).visible, true);
  });

  test("a shadow-DOM component elsewhere does not revoke control", () => {
    const { bar, doc, win } = build();
    const card = doc.createElement("div");
    doc.body.appendChild(card);
    const inner = doc.createElement("div");
    inner.id = "elsewhere";
    card.attachShadow({ mode: "open" }).appendChild(inner);
    (inner as any).getBoundingClientRect = () => ({
      width: 300, height: 100, top: 400, left: 0, bottom: 500, right: 300,
    });
    assert.equal(controlUiVisibility(bar, win).visible, true);
  });

  test("a background video behind the bar does not revoke control", () => {
    // Overlap is not occlusion. A full-bleed background video or canvas --
    // pointer-events:none, z-index 0, an entirely ordinary hero pattern --
    // overlaps the bar's rect while painting behind it. Checking only the
    // rectangles revoked control on pages where the bar was plainly visible.
    for (const tag of ["video", "canvas", "iframe", "img"]) {
      const { bar, doc, win } = build({
        styles: { bg: { pointerEvents: "none", zIndex: "0" } },
      });
      const bg = doc.createElement(tag);
      bg.id = "bg";
      doc.body.appendChild(bg);
      (bg as any).getBoundingClientRect = () => ({
        width: 1024, height: 768, top: 0, left: 0, bottom: 768, right: 1024,
      });
      assert.equal(controlUiVisibility(bar, win).visible, true, tag);
    }
  });

  test("a scrim at the bar's own stacking level still revokes", () => {
    // Equal levels err towards revoking: at the same z-index paint order
    // decides, and this cannot cheaply tell which came last.
    const { bar, doc, win } = build({
      styles: { veil: { pointerEvents: "none", zIndex: BAR_Z } },
    });
    const veil = doc.createElement("div");
    veil.id = "veil";
    doc.body.appendChild(veil);
    (veil as any).getBoundingClientRect = () => ({
      width: 1024, height: 400, top: 0, left: 0, bottom: 400, right: 1024,
    });
    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_obscured");
  });

  test("one crowded shadow root does not starve another", () => {
    // The budget used to be drained root by root. Roots are discovered in
    // reverse document order, so a scrim in a host EARLY in the document is
    // discovered last -- and if the hosts after it hold more elements than
    // the whole budget, it never got any and the scrim was missed purely
    // because the page was big, which the page controls.
    const { bar, doc, win } = build({
      styles: { veil: { pointerEvents: "none", zIndex: BAR_Z } },
    });
    const nowhere = () => ({
      width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0,
    });

    // The scrim's host goes FIRST, so it is discovered LAST.
    const scrimHost = doc.createElement("div");
    doc.body.appendChild(scrimHost);
    const veil = doc.createElement("div");
    veil.id = "veil";
    scrimHost.attachShadow({ mode: "open" }).appendChild(veil);
    (veil as any).getBoundingClientRect = () => ({
      width: 1024, height: 400, top: 0, left: 0, bottom: 400, right: 1024,
    });

    // Then twenty crowded components after it -- 6000 elements, well past
    // the whole scan budget.
    for (let h = 0; h < 20; h++) {
      const host = doc.createElement("div");
      doc.body.appendChild(host);
      const root = host.attachShadow({ mode: "open" });
      for (let i = 0; i < 300; i++) {
        const filler = doc.createElement("span");
        (filler as any).getBoundingClientRect = nowhere;
        root.appendChild(filler);
      }
    }

    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false, "the scrim must still be found");
    assert.equal(v.reason, "control_ui_obscured");
  });

  test("a big light DOM does not starve the shadow-root scan", () => {
    // The scan budget used to be drained root by root, so a light DOM larger
    // than the cap spent all of it before any shadow root was looked at --
    // and a scrim inside one was missed purely because the page was big,
    // which the page controls. Every root gets a share now.
    const { bar, doc, win } = build({
      styles: { veil: { pointerEvents: "none", zIndex: BAR_Z } },
    });
    const holder = doc.createElement("div");
    doc.body.appendChild(holder);
    const veil = doc.createElement("div");
    veil.id = "veil";
    holder.attachShadow({ mode: "open" }).appendChild(veil);
    (veil as any).getBoundingClientRect = () => ({
      width: 1024, height: 400, top: 0, left: 0, bottom: 400, right: 1024,
    });

    // ...and then far more light-DOM elements than the whole budget, all
    // AFTER the shadow host, which is the order that defeated the old scan.
    for (let i = 0; i < 4500; i++) {
      const filler = doc.createElement("span");
      (filler as any).getBoundingClientRect = () => ({
        width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0,
      });
      doc.body.appendChild(filler);
    }

    const v = controlUiVisibility(bar, win);
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_obscured");
  });

  test("outermostHost climbs out of the shadow root to the light-DOM wrapper", () => {
    // This is what makes the hit test meaningful: an open shadow root
    // retargets elementFromPoint to its host, so the host is what we compare.
    const { bar, wrapper } = build();
    assert.equal(outermostHost(bar), wrapper);
  });
});
