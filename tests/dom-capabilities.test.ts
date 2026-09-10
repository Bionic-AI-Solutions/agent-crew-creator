/**
 * Tests for domCapabilities — the policy that decides whether an embed token
 * may read, or act on, the page it is embedded in.
 *
 * This function had no test despite being the whole server-side half of the
 * DOM safety model, and despite being applied in two places that must agree:
 * the admin write path (so an impossible token cannot be stored) and the
 * public read path (so a token that reached the table some other way is still
 * served the policy, not the row).
 *
 * Run: npx tsx --test tests/dom-capabilities.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { domCapabilities } from "../server/domCapabilities.ts";

const POPUP = { mode: "popup", allowedOrigins: ["https://app.example"] };

describe("domCapabilities", () => {
  test("popup token with both flags and an allowlist gets both", () => {
    assert.deepEqual(
      domCapabilities({ ...POPUP, allowDomRead: true, allowDomControl: true }),
      { allowDomRead: true, allowDomControl: true },
    );
  });

  test("iframe mode gets neither, whatever the flags say", () => {
    // An iframe is a separate document from the host page: it can reach
    // nothing through it, so granting either capability would be a lie that
    // only shows up as a silently dead feature.
    assert.deepEqual(
      domCapabilities({
        mode: "iframe",
        allowedOrigins: ["https://app.example"],
        allowDomRead: true,
        allowDomControl: true,
      }),
      { allowDomRead: false, allowDomControl: false },
    );
  });

  test("an unknown mode is treated as not-popup", () => {
    // Fails closed: a mode this function has never heard of must not inherit
    // popup's privileges by default.
    assert.deepEqual(
      domCapabilities({
        mode: "fullscreen",
        allowedOrigins: ["https://app.example"],
        allowDomRead: true,
        allowDomControl: true,
      }),
      { allowDomRead: false, allowDomControl: false },
    );
  });

  test("control without read is refused", () => {
    // Every action names a ref from the current listing, so control without
    // read is not a restricted capability -- it is an unusable one.
    assert.deepEqual(
      domCapabilities({ ...POPUP, allowDomRead: false, allowDomControl: true }),
      { allowDomRead: false, allowDomControl: false },
    );
  });

  test("control with an empty allowlist is refused, read survives", () => {
    // A token with no allowlist runs anywhere it is pasted. Read is a
    // disclosure the embedder opted into; control is not something to hand
    // to "anywhere".
    assert.deepEqual(
      domCapabilities({
        mode: "popup",
        allowedOrigins: [],
        allowDomRead: true,
        allowDomControl: true,
      }),
      { allowDomRead: true, allowDomControl: false },
    );
  });

  test("control with a null allowlist is refused", () => {
    // null is the column default and reads differently from [] in JS, so it
    // gets its own case rather than relying on ?? threading through.
    assert.deepEqual(
      domCapabilities({
        mode: "popup",
        allowedOrigins: null,
        allowDomRead: true,
        allowDomControl: true,
      }),
      { allowDomRead: true, allowDomControl: false },
    );
    assert.deepEqual(
      domCapabilities({
        mode: "popup",
        allowedOrigins: undefined,
        allowDomRead: true,
        allowDomControl: true,
      }),
      { allowDomRead: true, allowDomControl: false },
    );
  });

  test("omitted flags default to off", () => {
    assert.deepEqual(domCapabilities({ ...POPUP }), {
      allowDomRead: false,
      allowDomControl: false,
    });
  });
});
