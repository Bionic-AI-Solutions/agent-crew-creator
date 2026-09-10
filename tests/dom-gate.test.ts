/**
 * Tests for the action gate.
 *
 * This is the code that decides whether an agent may press Send on someone
 * else's page. Every refusal below is one a prompt could be argued out of,
 * which is exactly why the rule lives in code — so each of them is pinned.
 *
 * Run: npx tsx --test tests/dom-gate.test.ts
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  matchesDenylist,
  submitsForm,
  isPasswordField,
  isDismissal,
  visibleText,
  enclosingDialogText,
  evaluateAction,
  evaluateTyping,
  type GateContext,
} from "../client/src/embed/domGate.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://shop.example.com/checkout",
});
const document = dom.window.document;

const DEFAULT_DENYLIST = [
  "send", "delete", "pay", "submit", "transfer",
  "confirm", "publish", "buy", "remove",
];

function ctx(over: Partial<GateContext> = {}): GateContext {
  return {
    denylist: DEFAULT_DENYLIST,
    allowedOrigins: ["https://shop.example.com"],
    currentOrigin: "https://shop.example.com",
    ...over,
  };
}

function el(html: string): Element {
  document.body.innerHTML = html;
  const node = document.body.firstElementChild;
  if (!node) throw new Error("fixture produced no element");
  return node;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("matchesDenylist", () => {
  test("matches whole words, case-insensitively", () => {
    assert.equal(matchesDenylist("Send", DEFAULT_DENYLIST), "send");
    assert.equal(matchesDenylist("SEND EMAIL", DEFAULT_DENYLIST), "send");
    assert.equal(matchesDenylist("Send email now", DEFAULT_DENYLIST), "send");
  });

  test("does not match inside a longer word", () => {
    // Refusing these would teach the operator that the gate is noise, and a
    // gate people route around is worse than no gate.
    for (const name of ["Resend link", "Sender address", "Submitted items", "Buyer profile"]) {
      assert.equal(matchesDenylist(name, DEFAULT_DENYLIST), null, name);
    }
  });

  test("matches at string edges and across punctuation", () => {
    assert.equal(matchesDenylist("send", DEFAULT_DENYLIST), "send");
    assert.equal(matchesDenylist("(Delete)", DEFAULT_DENYLIST), "delete");
    assert.equal(matchesDenylist("Pay…", DEFAULT_DENYLIST), "pay");
  });

  test("supports multi-word terms so a narrower rule is expressible", () => {
    assert.equal(matchesDenylist("Delete account", ["delete account"]), "delete account");
    assert.equal(matchesDenylist("Delete draft", ["delete account"]), null);
  });

  test("treats an empty term as no rule, not as matching everything", () => {
    assert.equal(matchesDenylist("Anything at all", ["", "   "]), null);
  });

  test("does not read a denylist term as a regex", () => {
    // An operator typing ".*" means those two characters, not "match all".
    assert.equal(matchesDenylist("Send", [".*"]), null);
    assert.equal(matchesDenylist("Delete", ["(delete|send)"]), null);
    assert.equal(matchesDenylist("Anything", ["+"]), null);
  });

  test("matches a term containing regex characters literally", () => {
    // Escaping must not go so far that a real name stops matching.
    assert.equal(matchesDenylist("Buy c++ licence", ["c++"]), "c++");
    assert.equal(matchesDenylist("Delete (all)", ["(all)"]), "(all)");
  });

  test("cannot match a term made only of punctuation", () => {
    // A consequence of the word-boundary rule, worth stating: such a term is
    // inert rather than dangerously broad, which is the safe direction.
    assert.equal(matchesDenylist("a.*b", [".*"]), null);
  });

  test("is not defeated by an invisible character in the name", () => {
    // A page names its own controls. "Del\u200Bete Account" is pixel-identical
    // to "Delete Account" for every human who looks at it, and the gate's
    // claim is that it is code a page cannot argue with -- so a name the page
    // can make invisibly different is an argument it gets to win.
    assert.equal(matchesDenylist("Del\u200Bete Account", DEFAULT_DENYLIST), "delete");
    assert.equal(matchesDenylist("D\u200BE\u200BL\u200BE\u200BT\u200BE", DEFAULT_DENYLIST), "delete");
    assert.equal(matchesDenylist("Send\uFEFF reply", DEFAULT_DENYLIST), "send");
    assert.equal(matchesDenylist("\u202EPay now", DEFAULT_DENYLIST), "pay");
  });

  test("covers the invisibles a hand-written range list forgot", () => {
    // Each of these defeated the previous, enumerated version. The point is
    // less the specific characters than that a list assembled from memory is
    // as complete as the memory that assembled it -- so the rule now asks
    // Unicode what is a format character instead.
    const hidden = [
      "\u00AD",              // soft hyphen
      "\u034F",              // combining grapheme joiner
      "\u115F", "\u1160",    // Hangul fillers
      "\u17B4",              // Khmer inherent vowel
      "\u180E",              // Mongolian vowel separator
      "\u3164", "\uFFA0",    // Hangul filler, halfwidth
      "\u061C",              // Arabic letter mark
      "\uFFF9",              // interlinear annotation anchor
      "\uDB40\uDC20",        // tag space, U+E0020
    ];
    for (const ch of hidden) {
      assert.equal(
        matchesDenylist(`Del${ch}ete Account`, DEFAULT_DENYLIST),
        "delete",
        JSON.stringify(ch),
      );
    }
  });

  test("removing the invisible does not join two real words", () => {
    // Removed, not spaced -- but a genuine space must still separate.
    assert.equal(matchesDenylist("Resend link", DEFAULT_DENYLIST), null);
  });

  test("returns null for an unnamed control", () => {
    assert.equal(matchesDenylist("", DEFAULT_DENYLIST), null);
  });
});

describe("realm independence", () => {
  test("recognises a password field from another realm", () => {
    // The gate has to judge elements inside same-origin iframes. An
    // `instanceof HTMLInputElement` check would answer "not a password field"
    // for a node from another realm — failing open, in the one place that has
    // to fail closed.
    const other = new JSDOM('<input type="password">');
    const foreign = other.window.document.querySelector("input")!;
    assert.equal(foreign instanceof (dom.window as any).HTMLInputElement, false);
    assert.equal(isPasswordField(foreign), true);
  });

  test("recognises a submit button from another realm", () => {
    const other = new JSDOM("<form><button>Go</button></form>");
    const foreign = other.window.document.querySelector("button")!;
    assert.equal(submitsForm(foreign), true);
  });
});

describe("visibleText", () => {
  test("removes what cannot be seen and keeps what can", () => {
    assert.equal(visibleText("Del\u200Bete"), "Delete");
    assert.equal(visibleText("a\uFEFFb\u2060c"), "abc");
    assert.equal(visibleText("Save draft"), "Save draft");
    assert.equal(visibleText("naïve 😀"), "naïve 😀");
  });
});

describe("dialog and dismissal see the same text", () => {
  test("an invisible character cannot hide a dangerous dialog", () => {
    document.body.innerHTML =
      '<div role="dialog">Permanently del\u200Bete this account<button>OK</button></div>';
    const v = evaluateAction(document.querySelector("button")!, "OK", "ref_1", ctx());
    assert.equal((v as any).reason, "awaiting_user_confirmation");
  });

  test("an invisible character cannot fake a dismissal", () => {
    // "Cancel" spelled with a zero-width space is still Cancel, and must
    // still be allowed to close a dialog.
    document.body.innerHTML =
      '<div role="dialog">Delete this?<button>Can\u200Bcel</button></div>';
    const v = evaluateAction(document.querySelector("button")!, "Can\u200Bcel", "ref_1", ctx());
    assert.deepEqual(v, { allowed: true });
  });
});

describe("submitsForm", () => {
  test("catches an explicit submit", () => {
    assert.equal(submitsForm(el('<button type="submit">Go</button>')), true);
    assert.equal(submitsForm(el('<input type="submit" value="Go">')), true);
  });

  test("catches a bare button inside a form", () => {
    // The most commonly missed way to send something by accident.
    document.body.innerHTML = "<form><button>Go</button></form>";
    assert.equal(submitsForm(document.querySelector("button")!), true);
  });

  test("leaves a bare button outside a form alone", () => {
    assert.equal(submitsForm(el("<button>Go</button>")), false);
  });

  test("leaves an explicit non-submit button alone", () => {
    document.body.innerHTML = '<form><button type="button">Go</button></form>';
    assert.equal(submitsForm(document.querySelector("button")!), false);
  });
});

describe("enclosingDialogText", () => {
  test("finds the dialog a control sits in", () => {
    document.body.innerHTML =
      '<div role="dialog">Permanently delete this file? <button>OK</button></div>';
    assert.ok(enclosingDialogText(document.querySelector("button")!).includes("delete"));
  });

  test("is empty outside a dialog", () => {
    assert.equal(enclosingDialogText(el("<button>OK</button>")), "");
  });
});

describe("evaluateAction", () => {
  test("allows an ordinary control", () => {
    const v = evaluateAction(el("<button>Compose</button>"), "Compose", "ref_1", ctx());
    assert.deepEqual(v, { allowed: true });
  });

  test("refuses a denylisted name, without calling it an error", () => {
    const v = evaluateAction(el("<button>Send</button>"), "Send", "ref_1", ctx());
    assert.equal(v.allowed, false);
    // Not a failure: the user is being asked, which is the intended outcome.
    assert.equal((v as any).reason, "awaiting_user_confirmation");
  });

  test("refuses a form submission even when innocuously named", () => {
    document.body.innerHTML = '<form><button type="submit">Continue</button></form>';
    const v = evaluateAction(document.querySelector("button")!, "Continue", "ref_1", ctx());
    assert.equal((v as any).reason, "awaiting_user_confirmation");
  });

  test("refuses an innocuous button inside a dangerous dialog", () => {
    // "OK" is on no denylist; what it confirms is the point.
    document.body.innerHTML =
      '<div role="dialog">Delete this account permanently? <button>OK</button></div>';
    const v = evaluateAction(document.querySelector("button")!, "OK", "ref_1", ctx());
    assert.equal((v as any).reason, "awaiting_user_confirmation");
  });

  test("does not gate the way OUT of a dangerous dialog", () => {
    // Found by running the reader and gate against a demo support desk: every
    // control in a delete dialog was refused, Cancel included. Gating the exit
    // from danger is not a safety measure -- it just means the agent cannot
    // close a dialog it should never have opened without stopping to ask.
    document.body.innerHTML =
      '<div role="dialog">Delete this account permanently?' +
      '<button id="c">Cancel</button><button id="o">OK</button></div>';
    const cancel = evaluateAction(document.getElementById("c")!, "Cancel", "ref_1", ctx());
    assert.deepEqual(cancel, { allowed: true });
    // The affirmative control in the same dialog is still refused.
    const ok = evaluateAction(document.getElementById("o")!, "OK", "ref_2", ctx());
    assert.equal((ok as any).reason, "awaiting_user_confirmation");
  });

  test("a dismissal name does not excuse a denylisted control", () => {
    // The exemption is only from the dialog rule. A control whose own name is
    // denylisted was already refused before the dialog is even consulted.
    document.body.innerHTML =
      '<div role="dialog">Are you sure?<button>Delete</button></div>';
    const v = evaluateAction(document.querySelector("button")!, "Delete", "ref_1", ctx());
    assert.equal((v as any).reason, "awaiting_user_confirmation");
  });

  test("a dismissal name does not excuse a form submission", () => {
    document.body.innerHTML =
      '<div role="dialog">Delete this?<form><button type="submit">Cancel</button></form></div>';
    const v = evaluateAction(document.querySelector("button")!, "Cancel", "ref_1", ctx());
    assert.equal((v as any).reason, "awaiting_user_confirmation");
  });

  test("proceeds once the user has confirmed that exact ref", () => {
    const v = evaluateAction(el("<button>Send</button>"), "Send", "ref_1", ctx({
      confirmedRefs: new Set(["ref_1"]),
    }));
    assert.deepEqual(v, { allowed: true });
  });

  test("does not treat a confirmation of one ref as covering another", () => {
    const v = evaluateAction(el("<button>Send</button>"), "Send", "ref_9", ctx({
      confirmedRefs: new Set(["ref_1"]),
    }));
    assert.equal(v.allowed, false);
  });

  test("refuses a password field before anything else is considered", () => {
    const v = evaluateAction(
      el('<input type="password">'), "Password", "ref_1",
      // Everything else about this call is permissive; the rule still holds.
      ctx({ denylist: [], confirmedRefs: new Set(["ref_1"]) }),
    );
    assert.equal((v as any).reason, "password_field");
  });

  test("refuses an origin the token was not granted", () => {
    const v = evaluateAction(el("<button>Compose</button>"), "Compose", "ref_1", ctx({
      currentOrigin: "https://evil.example.com",
    }));
    assert.equal((v as any).reason, "origin_not_granted");
  });

  test("grants nothing when the allowlist is empty", () => {
    const v = evaluateAction(el("<button>Compose</button>"), "Compose", "ref_1", ctx({
      allowedOrigins: [],
    }));
    assert.equal((v as any).reason, "origin_not_granted");
  });

  test("checks the origin even for a ref the user already confirmed", () => {
    // Confirmation is about the action, never about where it happens.
    const v = evaluateAction(el("<button>Send</button>"), "Send", "ref_1", ctx({
      currentOrigin: "https://evil.example.com",
      confirmedRefs: new Set(["ref_1"]),
    }));
    assert.equal((v as any).reason, "origin_not_granted");
  });

  test("an empty denylist still leaves form submission and origin gated", () => {
    // An empty denylist is a legitimate choice for an agent driving its
    // owner's own form. It must not switch off the other rules.
    document.body.innerHTML = '<form><button type="submit">Send</button></form>';
    const v = evaluateAction(
      document.querySelector("button")!, "Send", "ref_1", ctx({ denylist: [] }),
    );
    assert.equal((v as any).reason, "awaiting_user_confirmation");
  });
});

describe("isDismissal", () => {
  test("recognises the words that only mean backing out", () => {
    for (const n of ["Cancel", "cancel", "Close", "No", "Not now", "Go back", "Never mind"]) {
      assert.equal(isDismissal(n), true, n);
    }
  });

  test("is not fooled by a longer name that merely contains one", () => {
    // "Cancel subscription" cancels a subscription; it does not dismiss a
    // dialog, and treating it as a dismissal would open exactly the wrong door.
    for (const n of ["Cancel subscription", "Close account", "No, delete it", "Backup now"]) {
      assert.equal(isDismissal(n), false, n);
    }
  });

  test("ignores surrounding punctuation", () => {
    assert.equal(isDismissal("Cancel!"), true);
    assert.equal(isDismissal(" (cancel) "), true);
  });
});

describe("evaluateTyping", () => {
  test("allows typing into a field named like a denylisted action", () => {
    // Filling in a box labelled "Send to" is not sending anything.
    const v = evaluateTyping(el('<input type="text" aria-label="Send to">'), ctx());
    assert.deepEqual(v, { allowed: true });
  });

  test("still refuses a password field", () => {
    const v = evaluateTyping(el('<input type="password">'), ctx());
    assert.equal((v as any).reason, "password_field");
  });

  test("still refuses an ungranted origin", () => {
    const v = evaluateTyping(el('<input type="text">'), ctx({ currentOrigin: "https://x.test" }));
    assert.equal((v as any).reason, "origin_not_granted");
  });
});

describe("submitsForm — association, not containment", () => {
  test("a button associated by the form attribute counts, wherever it sits", () => {
    // closest("form") only sees containment. <button form="checkout"> placed
    // outside its form is ordinary HTML and submits just as hard -- verified
    // against a real request, the click POSTed to /account/delete.
    const dom = new JSDOM(
      '<!doctype html><body>' +
      '<form id="f" action="/account/delete" method="post"></form>' +
      '<button id="b" form="f">Continue</button>' +
      "</body>",
    );
    const btn = dom.window.document.getElementById("b")!;
    assert.equal(submitsForm(btn), true);
  });

  test("input type=image is a submit button", () => {
    const dom = new JSDOM(
      '<!doctype html><body><form><input id="i" type="image" src="go.png" alt="Go"></form></body>',
    );
    assert.equal(submitsForm(dom.window.document.getElementById("i")!), true);
  });

  test("an ordinary button not associated with a form does not count", () => {
    const dom = new JSDOM('<!doctype html><body><button id="b">Show more</button></body>');
    assert.equal(submitsForm(dom.window.document.getElementById("b")!), false);
  });
});

describe("enclosingDialogText — text inside components", () => {
  test("reads dialog text rendered inside a shadow root", () => {
    // textContent stops at a shadow boundary, so a dialog whose message is
    // rendered by a web component read as just "OK" -- and the rule that
    // catches an innocuous button confirming something dangerous saw nothing.
    // Every design system that renders dialog bodies in components did this.
    const dom = new JSDOM(
      '<!doctype html><body><div role="dialog">' +
      "<x-msg id=\"m\"></x-msg><button id=\"ok\">OK</button></div></body>",
    );
    const doc = dom.window.document;
    const msg = doc.getElementById("m")!;
    msg.attachShadow({ mode: "open" }).textContent =
      "Permanently delete your account?";

    const text = enclosingDialogText(doc.getElementById("ok")!);
    assert.match(text, /Permanently delete your account/);
    assert.equal(matchesDenylist(text, ["delete"]), "delete");
  });

  test("still reads ordinary light-DOM dialog text", () => {
    const dom = new JSDOM(
      '<!doctype html><body><div role="dialog">' +
      "<p>Permanently delete your account?</p><button id=\"ok\">OK</button></div></body>",
    );
    const text = enclosingDialogText(dom.window.document.getElementById("ok")!);
    assert.match(text, /Permanently delete your account/);
  });

  test("a control outside any dialog has no dialog text", () => {
    const dom = new JSDOM('<!doctype html><body><button id="b">OK</button></body>');
    assert.equal(enclosingDialogText(dom.window.document.getElementById("b")!), "");
  });
});
