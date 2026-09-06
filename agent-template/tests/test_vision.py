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
    CAMERA, SCREENSHARE, SERVER_IMAGE_LIMIT, encode_params, images_over_budget,
    max_images, should_drop_on_unsubscribe, should_replace, source_rank,
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
