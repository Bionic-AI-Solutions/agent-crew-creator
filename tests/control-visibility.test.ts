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

  // ── what the browser says is covering us ──────────────────────
  //
  // Hit testing skips a pointer-events:none layer, so the browser is asked
  // directly (IntersectionObserver v2). These pin how its answer is used --
  // in particular that its "no" is not taken at face value, because it
  // refuses to certify visibility through effects it cannot reason about.

  /** Puts an opaque layer over the Stop end of the bar. */
  function coverStopEnd(doc: Document, id = "veil") {
    const veil = doc.createElement("div");
    veil.id = id;
    doc.body.appendChild(veil);
    (veil as any).getBoundingClientRect = () => ({
      width: 1024, height: 400, top: 0, left: 0, bottom: 400, right: 1024,
    });
    return veil;
  }

  test("the browser reporting covered revokes only when something opaque is there", () => {
    // The observer's answer is a trigger, not a verdict: `isVisible` goes
    // false when ANYTHING composites above the bar, including a fully
    // transparent portal root that renders nothing.
    const clear = build();
    assert.equal(
      controlUiVisibility(clear.bar, clear.win, { occluded: true }).visible,
      true,
      "nothing opaque over it -- the observer was noticing a transparent layer",
    );

    const covered = build({
      styles: { veil: { backgroundColor: "rgb(255, 255, 255)" } },
    });
    coverStopEnd(covered.doc);
    const v = controlUiVisibility(covered.bar, covered.win, { occluded: true });
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_obscured");
  });

  test("an opaque layer is ignored while the browser says nothing covers us", () => {
    // Corroboration never runs on its own. A background video overlapping the
    // bar's rect but painting behind it is exactly this case, and it is why
    // the probe is not allowed to decide anything by itself.
    const { bar, doc, win } = build({
      styles: { veil: { backgroundColor: "rgb(255, 255, 255)" } },
    });
    coverStopEnd(doc);
    assert.equal(controlUiVisibility(bar, win, { occluded: false }).visible, true);
    assert.equal(controlUiVisibility(bar, win, { occluded: null }).visible, true);
  });

  test("the widget's own bar is not mistaken for something covering it", () => {
    // The probe descends into open shadow roots, and ours holds the bar --
    // opaque and directly over the sample point. contains() does not cross a
    // shadow boundary, so without outermostHost the probe concluded the bar
    // was covered by the bar, on every page.
    const { bar, win } = build();
    assert.equal(controlUiVisibility(bar, win, { occluded: true }).visible, true);
  });

  test("a scrim inside another component's open shadow root is corroborated", () => {
    const { bar, doc, win } = build({
      styles: { veil: { backgroundColor: "rgb(255, 255, 255)" } },
    });
    const holder = doc.createElement("div");
    doc.body.appendChild(holder);
    const veil = doc.createElement("div");
    veil.id = "veil";
    holder.attachShadow({ mode: "open" }).appendChild(veil);
    (veil as any).getBoundingClientRect = () => ({
      width: 1024, height: 400, top: 0, left: 0, bottom: 400, right: 1024,
    });
    const v = controlUiVisibility(bar, win, { occluded: true });
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_obscured");
  });

  test("a layer covering only the near end leaves control alone", () => {
    // Stop sits at the far end, and the promise is that you can stop it --
    // not that every pixel of the banner is pristine. A 180x40 notification
    // at the top left leaves Stop pressable.
    const { bar, doc, win } = build({
      styles: { veil: { backgroundColor: "rgb(51, 51, 51)" } },
    });
    const veil = coverStopEnd(doc);
    (veil as any).getBoundingClientRect = () => ({
      width: 180, height: 40, top: 0, left: 0, bottom: 40, right: 180,
    });
    assert.equal(controlUiVisibility(bar, win, { occluded: true }).visible, true);
  });

  test("the browser reporting the bar visible allows control", () => {
    const { bar, win } = build();
    assert.equal(controlUiVisibility(bar, win, { occluded: false }).visible, true);
  });

  test("no answer at all is not treated as covered", () => {
    // IntersectionObserver v2 is Chromium-only today, and there is a moment
    // before its first callback on every browser. Neither is evidence of
    // anything, and revoking on absence of evidence would make the feature
    // unusable where it is unsupported.
    const { bar, win } = build();
    assert.equal(controlUiVisibility(bar, win, { occluded: null }).visible, true);
    assert.equal(controlUiVisibility(bar, win, {}).visible, true);
  });

  test("a hiding filter still revokes, whatever the browser says", () => {
    // The ancestor-effect escape hatch must not become a way past the checks
    // that judge those effects properly.
    const { bar, win } = build({ styles: { wrapper: { filter: "opacity(0)" } } });
    const v = controlUiVisibility(bar, win, { occluded: false });
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_filtered");
  });

  test("a cheap check that fails wins over the browser saying visible", () => {
    const { bar, win } = build({ styles: { wrapper: { display: "none" } } });
    const v = controlUiVisibility(bar, win, { occluded: false });
    assert.equal(v.visible, false);
    assert.equal(v.reason, "control_ui_hidden");
  });

  test("outermostHost climbs out of the shadow root to the light-DOM wrapper", () => {
    // This is what makes the hit test meaningful: an open shadow root
    // retargets elementFromPoint to its host, so the host is what we compare.
    const { bar, wrapper } = build();
    assert.equal(outermostHost(bar), wrapper);
  });
});
