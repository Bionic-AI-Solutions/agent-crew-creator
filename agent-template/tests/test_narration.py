"""Tests for suppressing tool-call narration.

Two production symptoms, one root each.

The user HEARD `delegate_to_letta: "..."` even though that exact string was
already in the filter's pattern list. The filter tested each streamed chunk on
its own, and a streaming LLM splits the marker across chunks ("delegate",
"_to", "_letta"), so no single chunk ever contained it.

The user also SAW it in the chat panel. Only tts_node was overridden, and that
governs audio; the transcript is a separate stream that nothing filtered.

Run: python3 -m pytest agent-template/tests/test_narration.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from agent.narration import (  # noqa: E402
    TOOL_NARRATION_PATTERNS, NarrationGate, looks_like_narration,
)


def _run(gate, chunks):
    """Feed chunks and return everything the gate let through."""
    return "".join(gate.feed(c) for c in chunks) + gate.flush()


# --- the regression that motivated this ----------------------------------

def test_marker_split_across_chunks_is_caught():
    """The whole bug: 'delegate_to_letta' arrives in pieces, and a per-chunk
    substring test matches none of them."""
    gate = NarrationGate()
    assert _run(gate, ["delegate", "_to", "_letta", ': "do the thing"']) == ""
    assert gate.tripped is True


def test_per_chunk_test_would_have_missed_it():
    """Pins why the old approach failed, so it cannot quietly come back."""
    chunks = ["delegate", "_to", "_letta"]
    assert not any(
        any(p in c.lower() for p in TOOL_NARRATION_PATTERNS) for c in chunks
    )
    assert looks_like_narration("".join(chunks)) is True


def test_the_exact_production_turn_is_suppressed():
    """Verbatim from the chat panel, including the model's invented user turn."""
    turn = (
        'delegate_to_letta: "Find and summarize the headline results from the '
        'audited financial results for the year ended March 2025." '
        "User: What happened?"
    )
    gate = NarrationGate()
    assert _run(gate, [turn[i:i + 7] for i in range(0, len(turn), 7)]) == ""


# --- ordinary speech must survive ----------------------------------------

def test_plain_speech_passes_through_unchanged():
    gate = NarrationGate()
    chunks = ["Revenue ", "grew ", "twelve ", "percent ", "this ", "year."]
    assert _run(gate, chunks) == "Revenue grew twelve percent this year."
    assert gate.tripped is False


def test_speech_before_the_marker_is_kept():
    """A turn that starts as real speech and then leaks tool syntax keeps the
    part the user was meant to hear."""
    gate = NarrationGate()
    out = _run(gate, ["Let me check that. ", "delegate_to_letta: \"go\""])
    assert out == "Let me check that. "


def test_nothing_after_a_marker_escapes():
    """The observed leak is a whole turn of tool syntax; there is nothing
    after it worth keeping, and the model's fake 'User:' turn must not slip
    out on the far side."""
    gate = NarrationGate()
    _run(gate, ["delegate_to_letta"])
    assert gate.feed("User: what happened?") == ""
    assert gate.flush() == ""


def test_empty_and_missing_chunks_are_harmless():
    gate = NarrationGate()
    assert _run(gate, ["", "Hello", "", " there", ""]) == "Hello there"


def test_flush_releases_the_held_tail():
    """The gate holds back a tail to span chunk boundaries; without flush the
    end of every clean turn would be silently truncated."""
    gate = NarrationGate()
    streamed = "".join(gate.feed(c) for c in ["Short"])
    assert streamed != "Short"          # some of it is still held
    assert streamed + gate.flush() == "Short"


def test_matching_is_case_insensitive():
    gate = NarrationGate()
    assert _run(gate, ["I will Delegate the work"]) == ""


def test_other_markers_also_trip():
    for marker in ("invoking", "function call", "tool call", "using my tool"):
        gate = NarrationGate()
        assert _run(gate, [f"Now {marker} to help"]) == "Now ", marker


def test_a_gate_is_per_turn_not_shared():
    """Each turn builds its own gate; a tripped one must not mute the next."""
    first = NarrationGate()
    _run(first, ["delegate_to_letta"])
    assert first.tripped is True
    second = NarrationGate()
    assert _run(second, ["All good now."]) == "All good now."


# --- the helper ----------------------------------------------------------

def test_looks_like_narration_on_whole_strings():
    assert looks_like_narration('delegate_to_letta: "x"') is True
    assert looks_like_narration("Revenue grew twelve percent.") is False
    assert looks_like_narration("") is False
    assert looks_like_narration(None) is False
