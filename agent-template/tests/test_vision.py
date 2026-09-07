"""Tests for the vision frame-selection logic.

Context: livekit-agents 1.6.5 forwards video frames ONLY to a RealtimeModel
session (AgentActivity.push_video -> self._rt_session). This agent is an
STT -> LLM -> TTS pipeline, so _rt_session is None and every frame was
discarded -- vision had never worked for camera OR screenshare despite
VISION_ENABLED=true. agent.vision holds the decisions the replacement path
makes; this file pins them.

Run: python3 -m pytest agent-template/tests/test_vision.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from agent.vision import (  # noqa: E402
    CAMERA, SCREENSHARE, SERVER_IMAGE_LIMIT, ScreenChangeDetector,
    change_params, encode_params, frame_signature, images_over_budget,
    max_images, proactive_enabled, should_drop_on_unsubscribe, should_replace,
    signature_distance, source_rank,
)


# --- source priority -----------------------------------------------------

def test_screenshare_outranks_camera():
    assert source_rank(SCREENSHARE) > source_rank(CAMERA)


def test_unknown_source_ranks_lowest():
    assert source_rank("") == 0
    assert source_rank("microphone") == 0


def test_screenshare_replaces_a_held_camera_frame():
    """Starting a screen share must take over immediately."""
    assert should_replace(CAMERA, SCREENSHARE) is True


def test_camera_never_displaces_a_live_screenshare():
    """The bug this rule prevents: both tracks publish at ~30 fps, so without
    a priority the last frame to arrive wins and the user asking about their
    screen gets shown their face instead."""
    assert should_replace(SCREENSHARE, CAMERA) is False


def test_same_source_refreshes():
    """A newer frame from the same source must supersede the older one,
    otherwise the agent shows a frozen first frame forever."""
    assert should_replace(CAMERA, CAMERA) is True
    assert should_replace(SCREENSHARE, SCREENSHARE) is True


def test_any_source_fills_an_empty_slot():
    assert should_replace("", CAMERA) is True
    assert should_replace("", SCREENSHARE) is True


# --- stale frame handling ------------------------------------------------

def test_held_frame_dropped_when_its_own_track_ends():
    """Stopping a screen share must not leave the LLM staring at the last
    frame of a screen the user already closed."""
    assert should_drop_on_unsubscribe(SCREENSHARE, SCREENSHARE) is True


def test_held_frame_survives_an_unrelated_track_ending():
    assert should_drop_on_unsubscribe(SCREENSHARE, CAMERA) is False


def test_nothing_to_drop_when_no_frame_held():
    assert should_drop_on_unsubscribe("", CAMERA) is False
    assert should_drop_on_unsubscribe("", "") is False


# --- encode parameters ---------------------------------------------------

def test_defaults_are_downscaled_not_full_resolution():
    """Full-resolution screenshare frames cost thousands of vision tokens on
    every single turn; the default must be a downscale."""
    max_dim, quality = encode_params({})
    assert max_dim == 1280
    assert quality == 80


def test_overrides_are_honoured():
    assert encode_params({"VISION_MAX_DIMENSION": "640",
                          "VISION_JPEG_QUALITY": "50"}) == (640, 50)


def test_malformed_overrides_fall_back_instead_of_crashing_the_turn():
    """A typo in a ConfigMap must not make every user turn raise."""
    assert encode_params({"VISION_MAX_DIMENSION": "wide"}) == (1280, 80)
    assert encode_params({"VISION_JPEG_QUALITY": ""}) == (1280, 80)


def test_nonpositive_dimensions_fall_back():
    assert encode_params({"VISION_MAX_DIMENSION": "0"}) == (1280, 80)
    assert encode_params({"VISION_MAX_DIMENSION": "-100"}) == (1280, 80)


def test_quality_is_capped_at_100():
    """PIL rejects quality > 100, which would raise inside the turn."""
    assert encode_params({"VISION_JPEG_QUALITY": "9000"})[1] == 100


# --- image budget --------------------------------------------------------
#
# Regression cover for the production outage where a jarvis voice session went
# silent partway through. A frame is attached on every user turn and nothing
# ever evicted the old ones, so once the context carried 17 images vLLM
# answered 400 ("At most 16 image(s) may be provided in one prompt"). The agent
# saw only "peer closed connection without sending complete message body" and
# retried, resending the same over-limit history — so the session stayed dead
# until the user reconnected.

def test_budget_defaults_well_below_the_server_cap():
    assert max_images({}) < SERVER_IMAGE_LIMIT
    assert max_images({}) == 4


def test_budget_override_is_honoured():
    assert max_images({"VISION_MAX_IMAGES": "8"}) == 8


def test_budget_override_cannot_reintroduce_the_400():
    # Even an operator asking for more than the server allows stays legal.
    assert max_images({"VISION_MAX_IMAGES": "99"}) == SERVER_IMAGE_LIMIT - 1
    assert max_images({"VISION_MAX_IMAGES": str(SERVER_IMAGE_LIMIT)}) < SERVER_IMAGE_LIMIT


def test_budget_malformed_override_falls_back():
    assert max_images({"VISION_MAX_IMAGES": "lots"}) == 4
    assert max_images({"VISION_MAX_IMAGES": ""}) == 4


def test_budget_floor_is_one_not_zero():
    # 0 would strip the frame we just attached, silently disabling vision.
    assert max_images({"VISION_MAX_IMAGES": "0"}) == 1
    assert max_images({"VISION_MAX_IMAGES": "-5"}) == 1


def test_nothing_evicted_while_under_budget():
    assert images_over_budget(0, 4) == 0
    assert images_over_budget(3, 4) == 0
    assert images_over_budget(4, 4) == 0


def test_oldest_evicted_once_over_budget():
    assert images_over_budget(5, 4) == 1
    assert images_over_budget(20, 4) == 16


def test_the_production_case_stays_under_the_cap():
    # 17 images is what produced the 400. After eviction the next prompt
    # carries the budget, not the backlog.
    keep = max_images({})
    total_before = 17
    remaining = total_before - images_over_budget(total_before, keep)
    assert remaining == keep
    assert remaining < SERVER_IMAGE_LIMIT


def test_a_long_session_never_grows_past_the_budget():
    # Simulate 50 turns, evicting before each attach the way the agent does.
    keep = max_images({})
    held = 0
    for _ in range(50):
        held -= images_over_budget(held, keep - 1)   # make room
        held += 1                                    # attach this turn's frame
        assert held <= keep
        assert held < SERVER_IMAGE_LIMIT


# --- screen change detection ---------------------------------------------
#
# The gap this covers: frames are held ~33 ms fresh, but reach the model only
# when the user speaks. Production logs showed a 66 s stretch of one jarvis
# session with no attach at all — the screen was free to change completely
# with the agent unaware. These pin when a change is worth interrupting for.


def _solid(width, height, value):
    """An RGBA frame of one flat colour."""
    return bytes([value, value, value, 255]) * (width * height)


def _split(width, height, left, right):
    """Left half `left`, right half `right` — a known fraction of the frame."""
    rows = []
    for _ in range(height):
        for x in range(width):
            v = left if x < width // 2 else right
            rows.extend([v, v, v, 255])
    return bytes(rows)


# --- signatures ---

def test_signature_is_fixed_size_regardless_of_resolution():
    """Cost per frame must not scale with resolution; a 1080p share is read at
    the same price as a thumbnail."""
    small = frame_signature(_solid(64, 64, 100), 64, 64)
    large = frame_signature(_solid(1920, 1080, 100), 1920, 1080)
    assert len(small) == len(large) == 16 * 16


def test_identical_frames_have_zero_distance():
    a = frame_signature(_solid(320, 240, 128), 320, 240)
    b = frame_signature(_solid(320, 240, 128), 320, 240)
    assert signature_distance(a, b) == 0.0


def test_whole_screen_change_is_near_total_distance():
    dark = frame_signature(_solid(320, 240, 10), 320, 240)
    light = frame_signature(_solid(320, 240, 240), 320, 240)
    assert signature_distance(dark, light) == 1.0


def test_half_screen_change_registers_about_half():
    before = frame_signature(_split(320, 240, 10, 10), 320, 240)
    after = frame_signature(_split(320, 240, 10, 240), 320, 240)
    assert 0.4 < signature_distance(before, after) < 0.6


def test_tiny_luma_drift_is_not_a_change():
    """JPEG/encoder noise must not read as the user changing the screen."""
    a = frame_signature(_solid(320, 240, 128), 320, 240)
    b = frame_signature(_solid(320, 240, 133), 320, 240)
    assert signature_distance(a, b) == 0.0


def test_malformed_frames_yield_no_signature_not_a_crash():
    """A truncated buffer must not raise inside the frame loop."""
    assert frame_signature(b"\x00" * 10, 320, 240) == b""
    assert frame_signature(None, 320, 240) == b""
    assert frame_signature(_solid(8, 8, 0), 0, 0) == b""


def test_missing_signature_is_not_reported_as_a_change():
    good = frame_signature(_solid(64, 64, 100), 64, 64)
    assert signature_distance(b"", good) == 0.0
    assert signature_distance(good, b"") == 0.0


# --- detector state machine ---

DARK = frame_signature(_solid(320, 240, 10), 320, 240)
LIGHT = frame_signature(_solid(320, 240, 240), 320, 240)
MID = frame_signature(_solid(320, 240, 125), 320, 240)


def test_first_frame_establishes_a_baseline_and_never_fires():
    """Starting a share must not immediately interrupt the user."""
    d = ScreenChangeDetector({})
    assert d.observe(DARK, now=0.0) is False


def test_a_still_screen_never_fires():
    d = ScreenChangeDetector({})
    d.observe(DARK, now=0.0)
    for t in range(1, 20):
        assert d.observe(DARK, now=float(t)) is False


def test_change_fires_only_after_it_settles():
    """The whole point of the settle window: fire once the screen has stopped
    moving, not on the first frame of a page transition."""
    d = ScreenChangeDetector({})
    d.observe(DARK, now=0.0)
    assert d.observe(LIGHT, now=1.0) is False      # change seen, still moving
    assert d.observe(LIGHT, now=1.2) is False      # settle window not elapsed
    assert d.observe(LIGHT, now=1.5) is True       # settled -> fire


def test_a_scroll_fires_once_at_the_end_not_per_frame():
    """A run of changing frames is one event, however many frames it spans."""
    d = ScreenChangeDetector({})
    d.observe(DARK, now=0.0)
    fires = []
    # 10 frames of motion, alternating, then the screen holds still.
    for i in range(10):
        t = 1.0 + i * 0.033
        fires.append(d.observe(LIGHT if i % 2 else DARK, now=t))
    assert not any(fires), "must not fire mid-scroll"
    settled = 1.0 + 10 * 0.033
    assert d.observe(DARK, now=settled + 0.05) is False   # too soon
    assert d.observe(DARK, now=settled + 0.5) is True     # one event


def test_cooldown_blocks_a_second_burst():
    """A busy screen must not turn the agent into a monologue."""
    d = ScreenChangeDetector({})
    d.observe(DARK, now=0.0)
    d.observe(LIGHT, now=1.0)
    assert d.observe(LIGHT, now=1.5) is True
    # A fresh change well inside the 15 s cooldown.
    d.observe(DARK, now=3.0)
    assert d.observe(DARK, now=3.5) is False


def test_a_change_suppressed_by_cooldown_does_not_fire_later():
    """It must be dropped, not queued — firing it minutes later would comment
    on a screen the user has long since moved past."""
    d = ScreenChangeDetector({})
    d.observe(DARK, now=0.0)
    d.observe(LIGHT, now=1.0)
    assert d.observe(LIGHT, now=1.5) is True
    d.observe(DARK, now=3.0)
    assert d.observe(DARK, now=3.5) is False      # suppressed
    # Long after the cooldown expires, with no new change, nothing fires.
    for t in (20.0, 30.0, 60.0):
        assert d.observe(DARK, now=t) is False


def test_a_new_change_after_the_cooldown_fires():
    d = ScreenChangeDetector({})
    d.observe(DARK, now=0.0)
    d.observe(LIGHT, now=1.0)
    assert d.observe(LIGHT, now=1.5) is True
    d.observe(DARK, now=40.0)
    assert d.observe(DARK, now=40.5) is True


def test_sub_threshold_change_never_fires():
    """A tenth of the screen is the bar; a spinner or clock must not clear it."""
    before = frame_signature(_split(320, 240, 10, 10), 320, 240)
    # Change only two columns of the 16-wide grid => 12.5%... use one column.
    after_bytes = bytearray(before)
    after_bytes[0] = 250          # a single cell out of 256
    d = ScreenChangeDetector({})
    d.observe(bytes(before), now=0.0)
    assert d.observe(bytes(after_bytes), now=1.0) is False
    assert d.observe(bytes(after_bytes), now=2.0) is False


def test_reset_makes_a_resumed_share_a_new_baseline():
    """Stopping and restarting a share must not read as one enormous change."""
    d = ScreenChangeDetector({})
    d.observe(DARK, now=0.0)
    d.reset()
    assert d.observe(LIGHT, now=5.0) is False   # baseline again, not a change
    assert d.observe(LIGHT, now=5.5) is False


def test_empty_signature_is_ignored_without_disturbing_state():
    """A malformed frame mid-share must not clear the baseline."""
    d = ScreenChangeDetector({})
    d.observe(DARK, now=0.0)
    assert d.observe(b"", now=0.5) is False
    assert d.observe(LIGHT, now=1.0) is False
    assert d.observe(LIGHT, now=1.5) is True    # baseline survived


# --- configuration ---

def test_proactive_is_opt_in():
    """Shipping this default-on would change behaviour for every tenant that
    has vision enabled but never asked for a talking screen watcher."""
    assert proactive_enabled({}) is False
    assert proactive_enabled({"VISION_PROACTIVE": "true"}) is True
    assert proactive_enabled({"VISION_PROACTIVE": "1"}) is True
    assert proactive_enabled({"VISION_PROACTIVE": "false"}) is False
    assert proactive_enabled({"VISION_PROACTIVE": "garbage"}) is False


def test_change_defaults():
    assert change_params({}) == (0.10, 0.4, 15.0)


def test_change_overrides_are_honoured():
    assert change_params({
        "VISION_CHANGE_THRESHOLD": "0.25",
        "VISION_CHANGE_SETTLE_SECONDS": "1.0",
        "VISION_CHANGE_COOLDOWN_SECONDS": "30",
    }) == (0.25, 1.0, 30.0)


def test_malformed_change_overrides_fall_back():
    """A typo in a ConfigMap must not break the frame loop."""
    assert change_params({"VISION_CHANGE_THRESHOLD": "aggressive"})[0] == 0.10
    assert change_params({"VISION_CHANGE_SETTLE_SECONDS": ""})[1] == 0.4
    assert change_params({"VISION_CHANGE_COOLDOWN_SECONDS": "-5"})[2] == 15.0
    assert change_params({"VISION_CHANGE_THRESHOLD": "0"})[0] == 0.10
