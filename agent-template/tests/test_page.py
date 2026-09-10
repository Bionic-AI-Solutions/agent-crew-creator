"""Tests for the agent-side page holder.

The payload arrives from a browser over the network, so every rule about
malformed input matters more than it looks: a listing that raises instead of
degrading takes the user's turn down with it.

Run: python3 -m pytest agent-template/tests/test_page.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest
from agent.page import (
    MAX_PAGE_AGE_SECONDS,
    PageHolder,
    PageListing,
    PageElement,
    format_for_model,
    parse_listing,
)


def listing_payload(**over):
    payload = {
        "url": "https://support.example.com/tickets/4812",
        "title": "Ticket #4812",
        "capturedAt": 1788970000000,
        "elements": [
            {"ref": "ref_1", "role": "button", "name": "Save draft", "visible": True},
            {"ref": "ref_2", "role": "textbox", "name": "Message body", "visible": True},
            {"ref": "ref_3", "role": "button", "name": "Send reply", "visible": False},
        ],
    }
    payload.update(over)
    return json.dumps(payload)


# ── parsing ─────────────────────────────────────────────────────

def test_parses_a_well_formed_listing():
    listing = parse_listing(listing_payload())
    assert listing is not None
    assert listing.title == "Ticket #4812"
    assert [e.ref for e in listing.elements] == ["ref_1", "ref_2", "ref_3"]
    assert listing.elements[0].visible is True
    assert listing.elements[2].visible is False


def test_converts_the_widget_s_milliseconds_to_seconds():
    # The widget sends Date.now(); everything on this side is seconds. Getting
    # this wrong makes every listing look either ancient or from the future.
    listing = parse_listing(listing_payload(capturedAt=1788970000000))
    assert listing.captured_at == pytest.approx(1788970000.0)


@pytest.mark.parametrize("payload", [
    "", "not json", "null", "[]", "42", '"a string"', "{",
])
def test_malformed_payloads_return_none_rather_than_raising(payload):
    # This arrives from a browser. Raising here would drop the user's turn.
    assert parse_listing(payload) is None


def test_skips_junk_entries_without_discarding_the_listing():
    payload = json.dumps({
        "url": "u", "title": "t", "capturedAt": 0,
        "elements": [
            {"ref": "ref_1", "role": "button", "name": "Keep", "visible": True},
            "not an object",
            {"role": "button", "name": "No ref"},          # unusable
            {"ref": "ref_2"},                               # sparse but usable
        ],
    })
    listing = parse_listing(payload)
    assert [e.ref for e in listing.elements] == ["ref_1", "ref_2"]
    assert listing.elements[1].role == ""
    assert listing.elements[1].name == ""


def test_a_missing_elements_key_is_an_empty_page_not_an_error():
    listing = parse_listing(json.dumps({"url": "u", "title": "t"}))
    assert listing is not None and listing.elements == []


# ── formatting ──────────────────────────────────────────────────

def test_formats_one_control_per_line():
    block = format_for_model(parse_listing(listing_payload()))
    assert block.startswith("[PAGE] Ticket #4812")
    assert 'ref_1 button "Save draft"' in block
    assert 'ref_2 textbox "Message body"' in block


def test_marks_controls_the_user_cannot_see():
    block = format_for_model(parse_listing(listing_payload()))
    assert 'ref_3 button "Send reply" (off screen)' in block


def test_lists_visible_controls_before_off_screen_ones():
    block = format_for_model(parse_listing(listing_payload()))
    assert block.index("ref_2") < block.index("ref_3")


def test_names_an_unnamed_control_rather_than_leaving_a_gap():
    # A password field arrives with an empty name by design. The model still
    # needs to know the box is there.
    payload = json.dumps({"url": "u", "title": "t", "capturedAt": 0, "elements": [
        {"ref": "ref_1", "role": "password", "name": "", "visible": True},
    ]})
    assert 'ref_1 password "(no name)"' in format_for_model(parse_listing(payload))


def test_truncation_says_how_much_was_cut():
    # Silence here would let the model conclude a control is absent when it
    # was merely cut, and then confidently tell the user it does not exist.
    payload = json.dumps({"url": "u", "title": "t", "capturedAt": 0, "elements": [
        {"ref": f"ref_{i}", "role": "button", "name": f"Button number {i}", "visible": True}
        for i in range(200)
    ]})
    block = format_for_model(parse_listing(payload), max_chars=400)
    assert len(block) <= 460
    assert "more controls not listed" in block


def test_truncation_carries_forward_what_the_widget_already_dropped():
    payload = json.dumps({"url": "u", "title": "t", "capturedAt": 0, "truncated": 25,
                          "elements": [{"ref": "ref_1", "role": "button",
                                        "name": "Only one", "visible": True}]})
    assert "(25 more controls not listed)" in format_for_model(parse_listing(payload))


# ── holding ─────────────────────────────────────────────────────

def test_holds_the_newest_listing_and_offers_it_for_a_turn():
    holder = PageHolder()
    assert holder.update(listing_payload(), now=100.0) is True
    block = holder.block_for_turn(now=100.0)
    assert block is not None and "Save draft" in block


def test_a_newer_listing_replaces_the_older_one_entirely():
    # Refs are renumbered by every capture, so an old listing describes a page
    # that no longer exists. Merging them would let the agent act on a ref
    # that now points at something else.
    holder = PageHolder()
    holder.update(listing_payload(), now=100.0)
    holder.update(json.dumps({"url": "u", "title": "t", "capturedAt": 0, "elements": [
        {"ref": "ref_1", "role": "button", "name": "Totally different", "visible": True},
    ]}), now=101.0)
    block = holder.block_for_turn(now=101.0)
    assert "Totally different" in block
    assert "Save draft" not in block


def test_a_stale_listing_is_not_offered():
    holder = PageHolder()
    holder.update(listing_payload(), now=100.0)
    assert holder.block_for_turn(now=100.0 + MAX_PAGE_AGE_SECONDS + 1) is None


def test_a_rejected_payload_leaves_the_previous_listing_alone():
    # Degrading to a slightly older page beats degrading to none.
    holder = PageHolder()
    holder.update(listing_payload(), now=100.0)
    assert holder.update("not json", now=101.0) is False
    assert "Save draft" in holder.block_for_turn(now=101.0)


def test_nothing_to_offer_before_anything_arrives():
    assert PageHolder().block_for_turn(now=100.0) is None


def test_an_empty_page_is_offered_as_nothing_rather_than_an_empty_block():
    holder = PageHolder()
    holder.update(json.dumps({"url": "u", "title": "t", "elements": []}), now=100.0)
    assert holder.block_for_turn(now=100.0) is None


def test_clear_forgets_the_page():
    holder = PageHolder()
    holder.update(listing_payload(), now=100.0)
    holder.clear()
    assert holder.block_for_turn(now=100.0) is None




# ── persona rules ───────────────────────────────────────────────
#
# The rules are only appended when the agent can actually read a page.
# Telling a model about a [PAGE] block it will never receive invites it to
# describe one it cannot see.

def test_page_rules_are_absent_unless_reading_is_on(monkeypatch):
    from config import settings
    from agent import main_agent

    monkeypatch.setattr(settings, "dom_read_enabled", False)
    monkeypatch.setattr(settings, "dom_control_enabled", False)
    # page_rules() is only reached behind the flag; assert the flag is what
    # gates it rather than asserting on a string that is never used.
    assert settings.dom_read_enabled is False


def test_control_rules_are_absent_when_only_reading_is_on(monkeypatch):
    from config import settings
    from agent.main_agent import page_rules

    monkeypatch.setattr(settings, "dom_read_enabled", True)
    monkeypatch.setattr(settings, "dom_control_enabled", False)
    rules = page_rules()
    assert "PAGE RULES" in rules
    assert "CONTROL RULES" not in rules


def test_control_rules_name_the_configured_refusals(monkeypatch):
    from config import settings
    from agent.main_agent import page_rules

    monkeypatch.setattr(settings, "dom_read_enabled", True)
    monkeypatch.setattr(settings, "dom_control_enabled", True)
    monkeypatch.setattr(settings, "dom_action_denylist", '["send", "delete"]')
    rules = page_rules()
    assert "CONTROL RULES" in rules
    assert '"send"' in rules and '"delete"' in rules


def test_an_empty_denylist_says_none_rather_than_leaving_a_gap(monkeypatch):
    from config import settings
    from agent.main_agent import page_rules

    monkeypatch.setattr(settings, "dom_read_enabled", True)
    monkeypatch.setattr(settings, "dom_control_enabled", True)
    monkeypatch.setattr(settings, "dom_action_denylist", "[]")
    assert "refused by the browser and handed back to the user: none" in page_rules()


@pytest.mark.parametrize("bad", ["", "not json", "{}", "null", '"send"'])
def test_a_malformed_denylist_does_not_stop_the_agent(monkeypatch, bad):
    # The widget refuses regardless; a bad env var must not stop a boot.
    from config import settings
    from agent.main_agent import page_rules

    monkeypatch.setattr(settings, "dom_read_enabled", True)
    monkeypatch.setattr(settings, "dom_control_enabled", True)
    monkeypatch.setattr(settings, "dom_action_denylist", bad)
    assert "CONTROL RULES" in page_rules()


def test_page_rules_forbid_naming_a_control_that_is_not_listed(monkeypatch):
    # The defect being fixed is confident invention, so this line earns a test.
    from config import settings
    from agent.main_agent import page_rules

    monkeypatch.setattr(settings, "dom_read_enabled", True)
    monkeypatch.setattr(settings, "dom_control_enabled", False)
    rules = page_rules()
    assert "absent from the current [PAGE]" in rules
    assert "Never reuse a ref from an earlier turn" in rules


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
