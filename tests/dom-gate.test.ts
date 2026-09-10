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
