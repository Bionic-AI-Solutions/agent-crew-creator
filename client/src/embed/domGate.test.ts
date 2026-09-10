/**
 * Tests for the action gate.
 *
 * This is the file that decides whether an agent may press Send on someone
 * else's page. Every refusal below is one a prompt could be argued out of,
 * which is the reason the rule lives in code — so each of them is pinned.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  matchesDenylist,
  submitsForm,
  enclosingDialogText,
  evaluateAction,
  evaluateTyping,
  type GateContext,
} from "./domGate";

const DEFAULT_DENYLIST = [
  "send",
  "delete",
  "pay",
  "submit",
  "transfer",
  "confirm",
  "publish",
  "buy",
  "remove",
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
  it("matches on whole words, case-insensitively", () => {
    expect(matchesDenylist("Send", DEFAULT_DENYLIST)).toBe("send");
    expect(matchesDenylist("SEND EMAIL", DEFAULT_DENYLIST)).toBe("send");
    expect(matchesDenylist("Send email now", DEFAULT_DENYLIST)).toBe("send");
  });

  it("does not match inside a longer word", () => {
    // Refusing these would train the operator that the gate is noise, and a
    // gate people route around is worse than no gate.
    for (const name of ["Resend link", "Sender address", "Submitted items", "Buyer profile"]) {
      expect(matchesDenylist(name, DEFAULT_DENYLIST)).toBeNull();
    }
  });

  it("matches at string edges and across punctuation", () => {
    expect(matchesDenylist("send", DEFAULT_DENYLIST)).toBe("send");
    expect(matchesDenylist("(Delete)", DEFAULT_DENYLIST)).toBe("delete");
    expect(matchesDenylist("Pay…", DEFAULT_DENYLIST)).toBe("pay");
  });

  it("supports multi-word terms so a narrower rule is expressible", () => {
    expect(matchesDenylist("Delete account", ["delete account"])).toBe("delete account");
    expect(matchesDenylist("Delete draft", ["delete account"])).toBeNull();
  });

  it("treats an empty or whitespace term as no rule, not as matching everything", () => {
    expect(matchesDenylist("Anything at all", ["", "   "])).toBeNull();
  });

  it("does not let a denylist term be read as a regex", () => {
    // An operator typing ".*" means those two characters, not "match all".
    expect(matchesDenylist("Send", [".*"])).toBeNull();
    expect(matchesDenylist("Delete", ["(delete|send)"])).toBeNull();
    expect(matchesDenylist("Anything", ["+"])).toBeNull();
  });

  it("matches a term containing regex characters literally", () => {
    // Escaping must not go so far that a real name stops matching.
    expect(matchesDenylist("Buy c++ licence", ["c++"])).toBe("c++");
    expect(matchesDenylist("Delete (all)", ["(all)"])).toBe("(all)");
  });

  it("cannot match a term made only of punctuation", () => {
    // A consequence of the word-boundary rule, worth stating: such a term is
    // inert rather than dangerously broad, which is the safe direction.
    expect(matchesDenylist("a.*b", [".*"])).toBeNull();
  });

  it("returns null for an unnamed control", () => {
    expect(matchesDenylist("", DEFAULT_DENYLIST)).toBeNull();
  });
});

describe("submitsForm", () => {
  it("catches an explicit submit", () => {
    expect(submitsForm(el('<button type="submit">Go</button>'))).toBe(true);
    expect(submitsForm(el('<input type="submit" value="Go">'))).toBe(true);
  });

  it("catches a bare button inside a form", () => {
    // The most commonly missed way to send something by accident.
    document.body.innerHTML = "<form><button>Go</button></form>";
    expect(submitsForm(document.querySelector("button")!)).toBe(true);
  });

  it("leaves a bare button outside a form alone", () => {
    expect(submitsForm(el("<button>Go</button>"))).toBe(false);
  });

  it("leaves an explicit non-submit button alone", () => {
    document.body.innerHTML = '<form><button type="button">Go</button></form>';
    expect(submitsForm(document.querySelector("button")!)).toBe(false);
  });
});

describe("enclosingDialogText", () => {
  it("finds the dialog a control sits in", () => {
    document.body.innerHTML =
      '<div role="dialog">Permanently delete this file? <button>OK</button></div>';
    expect(enclosingDialogText(document.querySelector("button")!)).toContain("delete");
  });

  it("is empty outside a dialog", () => {
    expect(enclosingDialogText(el("<button>OK</button>"))).toBe("");
  });
});

describe("evaluateAction", () => {
  it("allows an ordinary control", () => {
    expect(evaluateAction(el("<button>Compose</button>"), "Compose", "ref_1", ctx()))
      .toEqual({ allowed: true });
  });

  it("refuses a denylisted name, without calling it an error", () => {
    const verdict = evaluateAction(el("<button>Send</button>"), "Send", "ref_1", ctx());
    expect(verdict.allowed).toBe(false);
    // Not a failure: the user is being asked, which is the intended outcome.
    expect(verdict).toMatchObject({ reason: "awaiting_user_confirmation" });
  });

  it("refuses a form submission even when innocuously named", () => {
    document.body.innerHTML = '<form><button type="submit">Continue</button></form>';
    const verdict = evaluateAction(
      document.querySelector("button")!, "Continue", "ref_1", ctx(),
    );
    expect(verdict).toMatchObject({ reason: "awaiting_user_confirmation" });
  });

  it("refuses an innocuous button inside a dangerous dialog", () => {
    // "OK" is on no denylist; what it confirms is the point.
    document.body.innerHTML =
      '<div role="dialog">Delete this account permanently? <button>OK</button></div>';
    const verdict = evaluateAction(document.querySelector("button")!, "OK", "ref_1", ctx());
    expect(verdict).toMatchObject({ reason: "awaiting_user_confirmation" });
  });

  it("proceeds once the user has confirmed that exact ref", () => {
    const verdict = evaluateAction(el("<button>Send</button>"), "Send", "ref_1", ctx({
      confirmedRefs: new Set(["ref_1"]),
    }));
    expect(verdict).toEqual({ allowed: true });
  });

  it("does not treat a confirmation of one ref as covering another", () => {
    const verdict = evaluateAction(el("<button>Send</button>"), "Send", "ref_9", ctx({
      confirmedRefs: new Set(["ref_1"]),
    }));
    expect(verdict.allowed).toBe(false);
  });

  it("refuses a password field before anything else is considered", () => {
    const verdict = evaluateAction(
      el('<input type="password">'), "Password", "ref_1",
      // Everything else about this call is permissive; the rule still holds.
      ctx({ denylist: [], confirmedRefs: new Set(["ref_1"]) }),
    );
    expect(verdict).toMatchObject({ reason: "password_field" });
  });

  it("refuses an origin the token was not granted", () => {
    const verdict = evaluateAction(el("<button>Compose</button>"), "Compose", "ref_1", ctx({
      currentOrigin: "https://evil.example.com",
    }));
    expect(verdict).toMatchObject({ reason: "origin_not_granted" });
  });

  it("grants nothing when the allowlist is empty", () => {
    const verdict = evaluateAction(el("<button>Compose</button>"), "Compose", "ref_1", ctx({
      allowedOrigins: [],
    }));
    expect(verdict).toMatchObject({ reason: "origin_not_granted" });
  });

  it("checks the origin even for a ref the user already confirmed", () => {
    // Confirmation is about the action, never about where it happens.
    const verdict = evaluateAction(el("<button>Send</button>"), "Send", "ref_1", ctx({
      currentOrigin: "https://evil.example.com",
      confirmedRefs: new Set(["ref_1"]),
    }));
    expect(verdict).toMatchObject({ reason: "origin_not_granted" });
  });

  it("an empty denylist still leaves form submission and the origin gated", () => {
    // An empty denylist is a legitimate choice for an agent driving its
    // owner's own form. It must not switch off the other rules.
    document.body.innerHTML = '<form><button type="submit">Send</button></form>';
    const verdict = evaluateAction(
      document.querySelector("button")!, "Send", "ref_1", ctx({ denylist: [] }),
    );
    expect(verdict).toMatchObject({ reason: "awaiting_user_confirmation" });
  });
});

describe("evaluateTyping", () => {
  it("allows typing into an ordinary field named like a denylisted action", () => {
    // Filling in a box labelled "Send to" is not sending anything.
    expect(evaluateTyping(el('<input type="text" aria-label="Send to">'), ctx()))
      .toEqual({ allowed: true });
  });

  it("still refuses a password field", () => {
    expect(evaluateTyping(el('<input type="password">'), ctx()))
      .toMatchObject({ reason: "password_field" });
  });

  it("still refuses an ungranted origin", () => {
    expect(evaluateTyping(el('<input type="text">'), ctx({ currentOrigin: "https://x.test" })))
      .toMatchObject({ reason: "origin_not_granted" });
  });
});
