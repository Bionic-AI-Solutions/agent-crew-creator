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
    CAMERA, SCREENSHARE, encode_params, should_drop_on_unsubscribe,
    should_replace, source_rank,
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
