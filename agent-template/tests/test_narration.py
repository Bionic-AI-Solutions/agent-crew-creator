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


def test_flush_releases_a_held_partial_marker():
    """flush() still matters, but only for text that looked like it might
    become a marker. Ordinary speech is emitted as it arrives (see
    test_ordinary_speech_holds_nothing_back), which is what makes an
    interrupted turn safe."""
    gate = NarrationGate()
    streamed = "".join(gate.feed(c) for c in ["Ready. delegate_to_le"])
    assert streamed == "Ready. "        # the partial marker is held
    assert streamed + gate.flush() == "Ready. delegate_to_le"


def test_matching_is_case_insensitive():
    gate = NarrationGate()
    assert _run(gate, ['Here you go. Delegate_To_Letta: "x"']) == "Here you go. "


def test_cut_happens_at_the_earliest_marker_not_the_first_pattern():
    """A chat-template leak wraps the function name in tags:

        <tool_call>{"name": "delegate_to_letta", ...}</tool_call>

    Scanning patterns in list order and cutting at the first one that matched
    cut at delegate_to_letta's offset, so the opening tag and half the JSON
    were emitted as speech before the gate tripped."""
    gate = NarrationGate()
    buf = 'Sure, one moment. <tool_call>{"name": "delegate_to_letta"}</tool_call>'
    out = gate.feed(buf)
    assert out == "Sure, one moment. "
    assert "<tool_call>" not in out and "delegate" not in out


def test_earliest_marker_wins_mid_stream():
    """The list-order bug needs BOTH markers in one buffer with the tag first.

    An earlier version of this test split the payload so that "<tool_call>"
    completed on its own chunk -- only one pattern ever matched, list order
    never came into play, and the test passed with the bug reintroduced. The
    conflict only exists when a single chunk carries the tag AND the function
    name, so that is what this delivers, after a prior chunk to keep it a
    streaming case rather than a single-buffer one.
    """
    gate = NarrationGate()
    seq = ["Sure, one sec. ", '<tool_call>{"name": "delegate_to_letta"}', "</tool_call>"]
    out = "".join(gate.feed(c) for c in seq) + gate.flush()
    assert out == "Sure, one sec. "
    assert "<tool_call>" not in out and "delegate" not in out
    assert gate.tripped is True


def test_ordinary_speech_holds_nothing_back():
    """The gate used to hold a fixed 16 characters, so a turn's last word sat
    in the buffer and was lost whenever an interruption cancelled the stream
    before flush(). Only a suffix that could still become a marker is held."""
    gate = NarrationGate()
    text = "The prototype chain resolves at run time."
    emitted = "".join(gate.feed(c) for c in [text[i:i + 7] for i in range(0, len(text), 7)])
    assert emitted == text, "nothing should be held back for ordinary speech"


def test_a_partial_marker_is_still_held():
    """The holdback must still exist when the text really could be a marker."""
    gate = NarrationGate()
    assert gate.feed("Ready. delegate_to_le") == "Ready. "
    assert gate.feed("tta: go") == ""
    assert gate.tripped is True


def test_chat_template_call_markers_trip():
    """The other way syntax leaks: the model emits its template's own call
    markers when it runs past the turn boundary."""
    for marker in ("<tool_call>", "</tool_call>", "<|tool_call|>"):
        gate = NarrationGate()
        assert _run(gate, [f"Sure. {marker} whatever"]) == "Sure. ", marker


# --- ordinary speech that must NOT be silenced --------------------------
#
# Every one of these tripped the old pattern list, and under the gate a trip
# discards the whole rest of the turn. This agent teaches, so programming and
# business vocabulary is exactly what it is expected to say.

def test_programming_explanation_is_not_treated_as_a_tool_call():
    gate = NarrationGate()
    text = ("When you're calling the constructor, the runtime invokes the "
            "prototype chain via a function call, and that tool call resolves "
            "at run time.")
    assert _run(gate, [text[i:i + 9] for i in range(0, len(text), 9)]) == text
    assert gate.tripped is False


def test_delegating_work_in_plain_english_is_not_silenced():
    gate = NarrationGate()
    text = "I will delegate that to the team and let me delegate the rest later."
    assert _run(gate, [text]) == text
    assert gate.tripped is False


def test_using_my_tools_in_plain_english_is_not_silenced():
    gate = NarrationGate()
    text = "Using my tool belt analogy: invoking a method is like calling the plumber."
    assert _run(gate, [text]) == text
    assert gate.tripped is False


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
