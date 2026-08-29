"""Pure decision logic for the agent's vision path.

Kept out of main_agent.py so it can be tested without importing the whole
livekit/plugin stack. main_agent.MainAgent holds the rtc plumbing; everything
here is a plain function over strings and ints.

Background: livekit-agents 1.6.5 delivers video frames only to a RealtimeModel
session (AgentActivity.push_video -> self._rt_session). A pipeline agent
(STT -> LLM -> TTS) therefore receives nothing, and must attach frames to the
chat context itself. These helpers decide WHICH frame to hold and HOW to
downscale it.
"""
from __future__ import annotations

import os

SCREENSHARE = "screenshare"
CAMERA = "camera"

# Screenshare outranks camera: when a user shares a screen they are almost
# always asking about the screen, and a face frame arriving 33 ms later must
# not displace it.
_PRIORITY = {SCREENSHARE: 2, CAMERA: 1}


def source_rank(source: str) -> int:
    """Priority of a video source; unknown/empty sources rank lowest."""
    return _PRIORITY.get(source, 0)


def should_replace(current_source: str, new_source: str) -> bool:
    """True if a frame from new_source may overwrite the held frame.

    Equal ranks replace (a newer camera frame supersedes an older camera
    frame), but a lower rank never displaces a higher one.
    """
    return source_rank(new_source) >= source_rank(current_source)


def should_drop_on_unsubscribe(held_source: str, ended_source: str) -> bool:
    """True if the held frame must be discarded when a track goes away.

    Without this the LLM keeps being shown a screen the user already stopped
    sharing.
    """
    if not held_source:
        return False
    return held_source == ended_source


def encode_params(env: dict | None = None) -> tuple[int, int]:
    """(max_dimension, jpeg_quality) for the attached still.

    Downscaling is not cosmetic: a raw screenshare frame can cost several
    thousand vision tokens per turn, on every turn. 1280 px keeps on-screen
    text legible at a fraction of that. Malformed overrides fall back to the
    defaults rather than crashing the turn.
    """
    src = os.environ if env is None else env

    def _int(name: str, default: int) -> int:
        try:
            value = int(src.get(name, default))
        except (TypeError, ValueError):
            return default
        return value if value > 0 else default

    quality = _int("VISION_JPEG_QUALITY", 80)
    return _int("VISION_MAX_DIMENSION", 1280), min(quality, 100)
