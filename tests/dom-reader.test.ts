/**
 * Tests for the page reader.
 *
 * Two rules here are not preferences: a password field's contents must never
 * leave the browser, and refs must renumber on every capture so the agent
 * cannot act on a remembered one. Both are pinned below.
 *
 * Run: npx tsx --test tests/dom-reader.test.ts
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  accessibleName,
  elementRole,
  isRendered,
  capturePage,
  resolveRef,
  MAX_ELEMENTS,
} from "../client/src/embed/domReader.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://mail.example.com/inbox",
});
const document = dom.window.document;
const window = dom.window as unknown as Window;

/**
 * jsdom reports every element as zero-area, which would make the reader treat
 * the whole page as unrendered and short-circuit the very rules under test.
 * Give elements a real box, honouring display:none so that branch still works.
 */
function withLayout(topFor: (el: Element) => number = () => 10) {
  (dom.window.Element.prototype as any).getBoundingClientRect = function () {
    const style = dom.window.getComputedStyle(this as Element);
    if (style.display === "none") {
      return { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
    }
    const top = topFor(this as Element);
    return { width: 100, height: 20, top, left: 0, bottom: top + 20, right: 100 };
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  withLayout();
});

describe("accessibleName", () => {
  test("prefers aria-label above everything", () => {
    document.body.innerHTML =
      '<button aria-label="Compose message" title="tooltip">Write</button>';
    assert.equal(accessibleName(document.querySelector("button")!, document), "Compose message");
  });

  test("falls back through labelledby, label, text, placeholder, title, alt", () => {
    document.body.innerHTML = `
      <span id="lbl">By reference</span>
      <button id="b1" aria-labelledby="lbl">ignored</button>
      <label for="f1">By label</label><input id="f1">
      <button id="b3">By text</button>
      <input id="f4" placeholder="By placeholder">
      <a id="a5" href="#" title="By title"></a>
      <img id="i6" alt="By alt">`;
    const q = (s: string) => document.querySelector(s)!;
    assert.equal(accessibleName(q("#b1"), document), "By reference");
    assert.equal(accessibleName(q("#f1"), document), "By label");
    assert.equal(accessibleName(q("#b3"), document), "By text");
    assert.equal(accessibleName(q("#f4"), document), "By placeholder");
    assert.equal(accessibleName(q("#a5"), document), "By title");
    assert.equal(accessibleName(q("#i6"), document), "By alt");
  });

  test("survives an id that would break a CSS selector", () => {
    // An id containing quotes or brackets used to throw out of the label
    // lookup, losing the whole capture rather than one name.
    document.body.innerHTML =
      `<label for='a"b[0]'>Quoted</label><input id='a"b[0]'>`;
    assert.equal(accessibleName(document.querySelector("input")!, document), "Quoted");
  });

  test("returns empty rather than inventing a name", () => {
    document.body.innerHTML = "<button></button>";
    assert.equal(accessibleName(document.querySelector("button")!, document), "");
  });
});

describe("elementRole", () => {
  test("honours an explicit role over the tag", () => {
    document.body.innerHTML = '<div role="Button">x</div>';
    assert.equal(elementRole(document.querySelector("div")!), "button");
  });

  test("maps input types to what a user would call them", () => {
    document.body.innerHTML = `
      <input type="checkbox"><input type="submit"><input type="text"><input>
      <textarea></textarea><select></select><a href="#">x</a>`;
    const expected = ["checkbox", "button", "textbox", "textbox", "textbox", "combobox", "link"];
    const els = document.querySelectorAll("input, textarea, select, a");
    els.forEach((el, i) => assert.equal(elementRole(el), expected[i], `#${i}`));
  });
});

describe("isRendered", () => {
  test("skips hidden, aria-hidden and display:none", () => {
    document.body.innerHTML = `
      <button id="ok">a</button>
      <button id="h" hidden>b</button>
      <button id="ah" aria-hidden="true">c</button>
      <button id="dn" style="display:none">d</button>`;
    assert.equal(isRendered(document.getElementById("ok")!, window), true);
    for (const id of ["h", "ah", "dn"]) {
      assert.equal(isRendered(document.getElementById(id)!, window), false, id);
    }
  });
});

describe("capturePage", () => {
  test("lists interactive controls with refs, roles and names", () => {
    document.body.innerHTML = `
      <button>Compose</button>
      <input aria-label="To recipients">
      <p>not interactive</p>
      <a href="#">Inbox</a>`;
    const page = capturePage(document, window);
    assert.deepEqual(
      page.elements.map((e) => [e.ref, e.role, e.name]),
      [
        ["ref_1", "button", "Compose"],
        ["ref_2", "textbox", "To recipients"],
        ["ref_3", "link", "Inbox"],
      ],
    );
  });

  test("never emits anything from a password field", () => {
    // The field is listed so the agent knows the box exists; nothing about
    // what is in it may leave the browser.
    document.body.innerHTML =
      '<input type="password" value="hunter2" aria-label="Password" placeholder="hunter2">';
    const page = capturePage(document, window);
    assert.equal(page.elements.length, 1);
    assert.equal(page.elements[0].role, "password");
    assert.equal(page.elements[0].name, "");
    assert.equal(JSON.stringify(page).includes("hunter2"), false);
  });

  test("omits elements that are not rendered", () => {
    document.body.innerHTML =
      '<button>Shown</button><button style="display:none">Hidden</button>';
    const page = capturePage(document, window);
    assert.deepEqual(page.elements.map((e) => e.name), ["Shown"]);
  });

  test("caps the listing and reports what it dropped", () => {
    // A listing that blows the context window is worse than none.
    document.body.innerHTML = Array.from(
      { length: MAX_ELEMENTS + 25 },
      (_, i) => `<button>B${i}</button>`,
    ).join("");
    const page = capturePage(document, window);
    assert.equal(page.elements.length, MAX_ELEMENTS);
    assert.equal(page.truncated, 25);
  });

  test("keeps controls in the viewport ahead of those below the fold", () => {
    document.body.innerHTML = '<button id="far">Far</button><button id="near">Near</button>';
    withLayout((el) => (el.id === "far" ? 5000 : 10));
    const page = capturePage(document, window);
    assert.equal(page.elements[0].name, "Near");
    assert.equal(page.elements[0].visible, true);
    assert.equal(page.elements[1].visible, false);
  });

  test("renumbers on every capture, so a remembered ref cannot be trusted", () => {
    // The agent must act on the newest listing. If refs were stable across
    // captures, one held from a previous turn would silently point at
    // whatever now occupies that position.
    document.body.innerHTML = "<button>Second</button>";
    const before = capturePage(document, window);
    assert.equal(before.elements[0].ref, "ref_1");
    assert.equal(before.elements[0].name, "Second");

    document.body.innerHTML = "<button>First</button><button>Second</button>";
    const after = capturePage(document, window);
    assert.equal(after.elements[0].name, "First");
    assert.equal(after.elements[1].name, "Second");
  });
});

describe("resolveRef", () => {
  test("resolves a ref to the element the listing named", () => {
    document.body.innerHTML = "<button>A</button><button>B</button>";
    const page = capturePage(document, window);
    assert.equal(resolveRef(page.elements[1].ref, document, window)?.textContent, "B");
  });

  test("returns null for a ref the page no longer has", () => {
    document.body.innerHTML = "<button>A</button>";
    assert.equal(resolveRef("ref_9", document, window), null);
  });

  test("returns null for a malformed ref rather than guessing", () => {
    document.body.innerHTML = "<button>A</button>";
    for (const bad of ["", "ref_", "ref_0", "ref_-1", "1", "button"]) {
      assert.equal(resolveRef(bad, document, window), null, bad);
    }
  });

  test("resolves against the page as it is NOW, not as it was", () => {
    // The honest failure mode: after the page changes, a stale ref points at
    // whatever is there now — which is exactly why the agent is told to
    // re-read and never reuse a ref across turns.
    document.body.innerHTML = "<button>Original</button>";
    const page = capturePage(document, window);
    document.body.innerHTML = "<button>Replaced</button>";
    assert.equal(resolveRef(page.elements[0].ref, document, window)?.textContent, "Replaced");
  });
});
