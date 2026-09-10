/**
 * Tests for the page reader.
 *
 * Two rules here are not preferences: a password field's contents must never
 * leave the browser, and refs must renumber on every capture so the agent
 * cannot act on a remembered one. Both are pinned below.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  accessibleName,
  elementRole,
  isRendered,
  capturePage,
  resolveRef,
  MAX_ELEMENTS,
} from "./domReader";

beforeEach(() => {
  document.body.innerHTML = "";
});

/**
 * jsdom reports every element as zero-area, which would make the reader
 * consider the whole page unrendered. Give elements a real box so the
 * visibility rules are exercised rather than short-circuited.
 */
function withLayout(height = 20, top = 0) {
  Element.prototype.getBoundingClientRect = function () {
    const style = window.getComputedStyle(this as Element);
    if (style.display === "none") {
      return { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 } as DOMRect;
    }
    return {
      width: 100, height, top, left: 0, bottom: top + height, right: 100,
    } as DOMRect;
  };
}

describe("accessibleName", () => {
  it("prefers aria-label above everything", () => {
    document.body.innerHTML =
      '<button aria-label="Compose message" title="tooltip">Write</button>';
    expect(accessibleName(document.querySelector("button")!)).toBe("Compose message");
  });

  it("falls back through labelledby, label, text, placeholder, title, alt", () => {
    document.body.innerHTML = `
      <span id="lbl">By reference</span>
      <button aria-labelledby="lbl">ignored</button>
      <label for="f1">By label</label><input id="f1">
      <button id="b3">By text</button>
      <input id="f4" placeholder="By placeholder">
      <a id="a5" href="#" title="By title"></a>
      <img id="i6" alt="By alt">`;
    const q = (s: string) => document.querySelector(s)!;
    expect(accessibleName(q("button[aria-labelledby]"))).toBe("By reference");
    expect(accessibleName(q("#f1"))).toBe("By label");
    expect(accessibleName(q("#b3"))).toBe("By text");
    expect(accessibleName(q("#f4"))).toBe("By placeholder");
    expect(accessibleName(q("#a5"))).toBe("By title");
    expect(accessibleName(q("#i6"))).toBe("By alt");
  });

  it("returns empty rather than inventing a name", () => {
    document.body.innerHTML = '<button></button>';
    expect(accessibleName(document.querySelector("button")!)).toBe("");
  });
});

describe("elementRole", () => {
  it("honours an explicit role over the tag", () => {
    document.body.innerHTML = '<div role="Button">x</div>';
    expect(elementRole(document.querySelector("div")!)).toBe("button");
  });

  it("maps input types to what a user would call them", () => {
    document.body.innerHTML = `
      <input type="checkbox"><input type="submit"><input type="text">
      <textarea></textarea><select></select><a href="#">x</a>`;
    const roles = ["checkbox", "button", "textbox", "textbox", "combobox", "link"];
    const els = document.querySelectorAll("input, textarea, select, a");
    els.forEach((el, i) => expect(elementRole(el)).toBe(roles[i]));
  });
});

describe("isRendered", () => {
  beforeEach(() => withLayout());

  it("skips hidden, aria-hidden and display:none", () => {
    document.body.innerHTML = `
      <button id="ok">a</button>
      <button id="h" hidden>b</button>
      <button id="ah" aria-hidden="true">c</button>
      <button id="dn" style="display:none">d</button>`;
    expect(isRendered(document.getElementById("ok")!, window)).toBe(true);
    for (const id of ["h", "ah", "dn"]) {
      expect(isRendered(document.getElementById(id)!, window)).toBe(false);
    }
  });
});

describe("capturePage", () => {
  beforeEach(() => withLayout());

  it("lists interactive controls with refs, roles and names", () => {
    document.body.innerHTML = `
      <button>Compose</button>
      <input aria-label="To recipients">
      <p>not interactive</p>
      <a href="#">Inbox</a>`;
    const page = capturePage(document, window);
    expect(page.elements.map((e) => [e.ref, e.role, e.name])).toEqual([
      ["ref_1", "button", "Compose"],
      ["ref_2", "textbox", "To recipients"],
      ["ref_3", "link", "Inbox"],
    ]);
  });

  it("never emits anything from a password field", () => {
    // The field is listed so the agent knows the box exists; nothing about
    // what is in it may leave the browser.
    document.body.innerHTML =
      '<input type="password" value="hunter2" aria-label="Password" placeholder="hunter2">';
    const page = capturePage(document, window);
    expect(page.elements).toHaveLength(1);
    expect(page.elements[0].role).toBe("password");
    expect(page.elements[0].name).toBe("");
    expect(JSON.stringify(page)).not.toContain("hunter2");
  });

  it("omits elements that are not rendered", () => {
    document.body.innerHTML = `
      <button>Shown</button><button style="display:none">Hidden</button>`;
    const page = capturePage(document, window);
    expect(page.elements.map((e) => e.name)).toEqual(["Shown"]);
  });

  it("caps the listing and reports what it dropped", () => {
    // A listing that blows the context window is worse than none.
    document.body.innerHTML = Array.from(
      { length: MAX_ELEMENTS + 25 },
      (_, i) => `<button>B${i}</button>`,
    ).join("");
    const page = capturePage(document, window);
    expect(page.elements).toHaveLength(MAX_ELEMENTS);
    expect(page.truncated).toBe(25);
  });

  it("keeps controls in the viewport ahead of those below the fold", () => {
    document.body.innerHTML = '<button id="far">Far</button><button id="near">Near</button>';
    const el = (id: string) => document.getElementById(id)!;
    Element.prototype.getBoundingClientRect = function () {
      const isFar = (this as Element).id === "far";
      const top = isFar ? 5000 : 10;
      return { width: 100, height: 20, top, left: 0, bottom: top + 20, right: 100 } as DOMRect;
    };
    const page = capturePage(document, window);
    expect(page.elements[0].name).toBe("Near");
    expect(page.elements[0].visible).toBe(true);
    expect(page.elements[1].visible).toBe(false);
    expect(el("far")).toBeTruthy();
  });

  it("renumbers on every capture, so a remembered ref cannot be trusted", () => {
    // The agent must act on the newest listing. If refs were stable across
    // captures, a ref held from a previous turn would silently point at
    // whatever now occupies that position.
    document.body.innerHTML = '<button>Second</button>';
    const before = capturePage(document, window);
    expect(before.elements[0]).toMatchObject({ ref: "ref_1", name: "Second" });

    document.body.innerHTML = '<button>First</button><button>Second</button>';
    const after = capturePage(document, window);
    expect(after.elements[0]).toMatchObject({ ref: "ref_1", name: "First" });
    expect(after.elements[1]).toMatchObject({ ref: "ref_2", name: "Second" });
  });
});

describe("resolveRef", () => {
  beforeEach(() => withLayout());

  it("resolves a ref to the element the listing named", () => {
    document.body.innerHTML = '<button>A</button><button>B</button>';
    const page = capturePage(document, window);
    const el = resolveRef(page.elements[1].ref, document, window);
    expect(el?.textContent).toBe("B");
  });

  it("returns null for a ref the page no longer has", () => {
    document.body.innerHTML = '<button>A</button>';
    expect(resolveRef("ref_9", document, window)).toBeNull();
  });

  it("returns null for a malformed ref rather than guessing", () => {
    document.body.innerHTML = '<button>A</button>';
    for (const bad of ["", "ref_", "ref_0", "ref_-1", "1", "button"]) {
      expect(resolveRef(bad, document, window)).toBeNull();
    }
  });

  it("resolves against the page as it is NOW, not as it was", () => {
    // The honest failure mode: after the page changes, a stale ref points at
    // whatever is there now, which is exactly why the agent is told to
    // re-read and never reuse a ref across turns.
    document.body.innerHTML = '<button>Original</button>';
    const page = capturePage(document, window);
    document.body.innerHTML = '<button>Replaced</button>';
    expect(resolveRef(page.elements[0].ref, document, window)?.textContent).toBe("Replaced");
  });
});
