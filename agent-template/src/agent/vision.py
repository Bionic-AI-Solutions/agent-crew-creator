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


# An OpenAI-compatible server rejects a prompt carrying more than this many
# images. vLLM raises "At most 16 image(s) may be provided in one prompt" and
# answers 400; the agent sees only a truncated stream, and because every retry
# resends the same over-limit history the session can never recover. Frames are
# attached once per turn and were never evicted, so any conversation longer
# than SERVER_IMAGE_LIMIT turns died.
SERVER_IMAGE_LIMIT = 16


def max_images(env: dict | None = None) -> int:
    """How many images may remain in the chat context, newest included.

    Defaults far below the server cap: an old frame is rarely what the user is
    asking about, and each one costs vision tokens on every subsequent turn.
    Clamped so a bad override cannot reintroduce the 400.
    """
    src = os.environ if env is None else env
    try:
        value = int(src.get("VISION_MAX_IMAGES", 4))
    except (TypeError, ValueError):
        return 4
    if value < 1:
        return 1
    return min(value, SERVER_IMAGE_LIMIT - 1)


def images_over_budget(total: int, keep: int) -> int:
    """How many of the oldest images to strip so at most `keep` remain."""
    if keep < 0:
        keep = 0
    return max(0, total - keep)


# ── Screen-change detection ──────────────────────────────────
#
# WHY (2026-09-07). Frames arrive push-based at ~30 fps and _read_video_track
# always holds one no more than ~33 ms old, so the image the LLM sees is never
# stale. What was missing is a *trigger*: the held frame reaches the model only
# in on_user_turn_completed, i.e. when the user speaks. Between turns the agent
# is blind — production logs for one jarvis session show a 66 s gap between
# consecutive attaches, during which the shared screen could change completely
# with the agent unaware.
#
# Polling faster fixes nothing (there is no poll). The fix is to notice that
# the pixels changed and start a turn. These helpers are the decision half;
# main_agent owns the rtc plumbing and the speech guards.


def _float(src: dict, name: str, default: float) -> float:
    """Positive float from env, falling back rather than crashing the stream."""
    try:
        value = float(src.get(name, default))
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def proactive_enabled(env: dict | None = None) -> bool:
    """Whether a screen change may start a turn on its own.

    Opt-in, not default-on: an agent that speaks every time the screen changes
    is intrusive, and this ships to tenants who never asked for it. Enable per
    tenant with VISION_PROACTIVE=true.
    """
    src = os.environ if env is None else env
    return str(src.get("VISION_PROACTIVE", "")).strip().lower() in {
        "1", "true", "yes", "on",
    }


def change_params(env: dict | None = None) -> tuple[float, float, float]:
    """(change_threshold, settle_seconds, cooldown_seconds).

    threshold — fraction of sampled cells that must move before the frame
      counts as a change. Too low and a blinking cursor or a video playing in
      a corner fires; 0.10 needs a tenth of the screen to differ.
    settle    — how long the screen must hold still afterwards. Without it a
      scroll or a page transition fires on every intermediate frame, and the
      model is handed a half-painted screen.
    cooldown  — floor between two proactive turns, so a busy screen cannot
      make the agent monologue.
    """
    src = os.environ if env is None else env
    return (
        _float(src, "VISION_CHANGE_THRESHOLD", 0.10),
        _float(src, "VISION_CHANGE_SETTLE_SECONDS", 0.4),
        _float(src, "VISION_CHANGE_COOLDOWN_SECONDS", 15.0),
    )


def motion_threshold(env: dict | None = None) -> float:
    """Adjacent-frame delta above which the screen counts as still moving.

    Separate from, and far below, the change threshold. This one answers "is
    it still moving?", not "has it changed?" -- a blinking cursor or a ticking
    clock moves one or two cells and must not hold the screen open forever,
    while a scroll or a page transition moves many.
    """
    src = os.environ if env is None else env
    return _float(src, "VISION_MOTION_THRESHOLD", 0.02)


def frame_signature(data, width: int, height: int, grid: int = 16) -> bytes:
    """Luma fingerprint of an RGBA frame: one sample at each grid cell centre.

    Sampling (grid*grid points) rather than averaging every pixel is what makes
    this affordable in the frame loop: 256 samples per frame is constant work
    regardless of resolution, where averaging a 1920x1080 frame would be ~2M
    reads 30 times a second in Python.

    Returns b"" for a frame that cannot be sampled, which signature_distance
    treats as "no comparison" rather than as a change.
    """
    if width <= 0 or height <= 0 or grid <= 0:
        return b""
    if data is None or len(data) < width * height * 4:
        return b""

    out = bytearray(grid * grid)
    i = 0
    for row in range(grid):
        y = (row * 2 + 1) * height // (grid * 2)
        row_base = y * width
        for col in range(grid):
            x = (col * 2 + 1) * width // (grid * 2)
            p = (row_base + x) * 4
            # Rec. 601 luma, integer-only.
            out[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) // 1000
            i += 1
    return bytes(out)


def signature_distance(a: bytes, b: bytes, cell_threshold: int = 16) -> float:
    """Fraction of cells whose luma moved by more than cell_threshold.

    Counting *cells changed* rather than averaging the difference keeps a small
    bright element (a notification, a spinner) from registering as a whole-page
    change, while a genuine navigation moves most of the grid at once.
    """
    if not a or not b or len(a) != len(b):
        return 0.0
    changed = sum(1 for x, y in zip(a, b) if abs(x - y) > cell_threshold)
    return changed / len(a)


class ScreenChangeDetector:
    """Decides when a run of frames amounts to "the screen changed, and settled".

    Deliberately free of clocks and rtc types: observe() takes the timestamp,
    so the whole state machine is testable without sleeping. main_agent feeds
    it signatures from the live track.

    Two comparisons, and they answer different questions:

      drift  = distance(baseline, current)  -- has the screen CHANGED?
      motion = distance(previous, current)  -- is it still MOVING?

    Measuring change against the immediately previous frame is the mistake
    this class made first, and it made the detector nearly inert in
    production: adjacent frames are ~33 ms apart, so a screen that transforms
    completely over a second -- a scroll, a page painting in, a fade, any
    progressive render -- never shows a 10% step between two of them and never
    fired. Only an abrupt single-frame cut did. Comparing against a baseline
    that is only re-taken when we actually fire lets gradual change accumulate
    until it crosses the threshold, which is what "the screen changed" means
    to the person watching it.
    """

    def __init__(self, env: dict | None = None) -> None:
        self.threshold, self.settle, self.cooldown = change_params(env)
        self.motion = motion_threshold(env)
        self._baseline = b""
        self._previous = b""
        self._last_motion_at = 0.0
        self._last_trigger_at: float | None = None

    def reset(self) -> None:
        """Forget the held signatures — used when the screenshare track ends,
        so resuming a share is not read as one enormous change."""
        self._baseline = b""
        self._previous = b""

    def drift(self) -> float:
        """How far the current frame has moved from the baseline. Diagnostic."""
        return signature_distance(self._baseline, self._previous)

    def observe(self, signature: bytes, now: float) -> bool:
        """Feed one frame. True exactly when a proactive turn should fire."""
        if not signature:
            return False

        previous, self._previous = self._previous, signature

        # First frame of a share is the baseline, not a change.
        if not self._baseline:
            self._baseline = signature
            return False
        if not previous:
            return False

        # Still moving? Hold off — speaking mid-transition means describing a
        # half-painted screen, and re-baselining now would swallow the change.
        if signature_distance(previous, signature) >= self.motion:
            self._last_motion_at = now
            return False

        if now - self._last_motion_at < self.settle:
            return False

        # Settled. Is it meaningfully different from what we last spoke about?
        # The baseline deliberately survives a non-firing settle, so slow drift
        # keeps accumulating instead of being forgiven frame by frame.
        if signature_distance(self._baseline, signature) < self.threshold:
            return False

        # Re-baseline on both paths below: a change suppressed by the cooldown
        # is dropped, not queued, so it cannot fire minutes later against a
        # screen the user has long since moved past.
        self._baseline = signature
        if self._last_trigger_at is not None and \
                now - self._last_trigger_at < self.cooldown:
            return False

        self._last_trigger_at = now
        return True
