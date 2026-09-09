"""Suppressing tool-call narration from what the user sees and hears.

Kept out of main_agent.py so the matching can be tested without importing the
livekit stack — the same split as agent.vision.

Two things leak a delegation into the conversation, and they leak by different
routes, so both nodes need the same gate:

  tts_node            -> the user HEARS "delegate_to_letta: ..."
  transcription_node  -> the user SEES it in the chat panel

The old filter only covered the first, and only per chunk. A streaming LLM
emits `delegate_to_letta` as several chunks ("delegate", "_to", "_letta"), so a
substring test against one chunk never matched — the pattern was in the list
and still went out loud. Matching has to span chunk boundaries, which is what
NarrationGate is for.
"""
from __future__ import annotations

# Markers that a turn is tool-call SYNTAX rather than speech.
#
# Every entry must be impossible in ordinary spoken English, because tripping
# on one discards the rest of the turn. The list used to also hold "calling
# the", "invoking", "function call", "tool call" and "using my tool", and
# those are ordinary words -- this agent teaches, and "when you're calling the
# constructor, the runtime invokes the prototype chain via a function call" is
# a sentence it should be able to say. Under the old per-chunk filter such a
# match cost a single chunk; under the gate it costs everything after it, so
# the same list became a mute button on legitimate answers about programming.
#
# What actually leaked in production was raw syntax: a turn reading
# delegate_to_letta: "..." followed by a hallucinated "User:" line, emitted
# because the model ran past its turn boundary. A function name and the
# chat-template's own call markers catch that and cannot be said by accident.
TOOL_NARRATION_PATTERNS: tuple[str, ...] = (
    "delegate_to_letta",
    "<tool_call>",
    "</tool_call>",
    "<|tool_call|>",
)


def looks_like_narration(text: str, patterns: tuple[str, ...] | None = None) -> bool:
    """True if *text* contains any narration marker."""
    if not text:
        return False
    lowered = text.lower()
    return any(p in lowered for p in (patterns or TOOL_NARRATION_PATTERNS))


class NarrationGate:
    """Streaming suppressor for tool-call narration.

    Feed it chunks; it returns the text that is safe to pass on. It holds back
    the last few characters of each chunk — enough to complete the longest
    pattern — so a marker split across chunks is still caught. Once a marker is
    seen the rest of the turn is dropped: the observed leak is a whole turn of
    tool syntax (`delegate_to_letta: "..." User: What happened?`), not a phrase
    embedded in real speech, so there is nothing after it worth keeping.
    """

    def __init__(self, patterns: tuple[str, ...] | None = None) -> None:
        self._patterns = patterns or TOOL_NARRATION_PATTERNS
        self._buf = ""
        self._tripped = False

    def _holdback(self, lowered: str) -> int:
        """How many trailing characters could still become a marker.

        Only a suffix that is already a proper prefix of some pattern is worth
        keeping. Holding a fixed 16 characters instead -- as this did first --
        meant ordinary speech always had its last word in the buffer, and an
        interruption cancels the generator before the flush, so that word was
        simply lost from both the audio and the transcript. Under this rule a
        sentence that looks nothing like a marker holds nothing, so there is
        nothing to lose.
        """
        keep = 0
        for pattern in self._patterns:
            for k in range(min(len(lowered), len(pattern) - 1), 0, -1):
                if pattern.startswith(lowered[-k:]):
                    keep = max(keep, k)
                    break
        return keep

    @property
    def tripped(self) -> bool:
        """Whether a marker has been seen and the turn is being dropped."""
        return self._tripped

    def feed(self, chunk: str) -> str:
        """Take one chunk; return the text safe to emit now (may be empty)."""
        if self._tripped:
            return ""
        if not chunk:
            return ""

        self._buf += chunk
        lowered = self._buf.lower()

        # Cut at the EARLIEST marker in the buffer, not at whichever pattern
        # happens to be first in the list. A chat-template leak looks like
        #     <tool_call>{"name": "delegate_to_letta", ...}</tool_call>
        # and checking delegate_to_letta first cut at ITS offset, emitting the
        # opening tag and half the JSON as though it were speech.
        hits = [i for i in (lowered.find(p) for p in self._patterns) if i != -1]
        if hits:
            idx = min(hits)
            # Anything before the marker was real speech and has been earned;
            # the marker and everything after it is dropped.
            self._tripped = True
            out, self._buf = self._buf[:idx], ""
            return out

        # Hold back only what could still grow into a marker.
        keep = self._holdback(lowered)
        if keep == 0:
            out, self._buf = self._buf, ""
            return out
        out, self._buf = self._buf[:-keep], self._buf[-keep:]
        return out

    def flush(self) -> str:
        """Emit whatever is still held back at the end of the turn."""
        if self._tripped:
            return ""
        out, self._buf = self._buf, ""
        return out
