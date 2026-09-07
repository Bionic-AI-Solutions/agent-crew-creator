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

# Substrings that mark a turn as tool-call narration rather than speech.
# Lowercase; matched case-insensitively.
TOOL_NARRATION_PATTERNS: tuple[str, ...] = (
    "delegate_to_letta",
    "calling the",
    "using my tool",
    "let me delegate",
    "i'll delegate",
    "i will delegate",
    "invoking",
    "function call",
    "tool call",
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
        self._hold = max((len(p) for p in self._patterns), default=1) - 1
        self._buf = ""
        self._tripped = False

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
        for pattern in self._patterns:
            idx = lowered.find(pattern)
            if idx != -1:
                # Anything before the marker was real speech and has been
                # earned; the marker and everything after it is dropped.
                self._tripped = True
                out, self._buf = self._buf[:idx], ""
                return out

        # Keep back enough tail that a marker straddling the next chunk
        # boundary still matches. Without this the gate has the same blind
        # spot as the per-chunk test it replaces.
        if len(self._buf) <= self._hold:
            return ""
        out, self._buf = self._buf[: -self._hold], self._buf[-self._hold :]
        return out

    def flush(self) -> str:
        """Emit whatever is still held back at the end of the turn."""
        if self._tripped:
            return ""
        out, self._buf = self._buf, ""
        return out
