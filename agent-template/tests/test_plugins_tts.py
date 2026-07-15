"""Regression tests for the Sarvam AI TTS provider branch in plugins.py.

Sarvam has a real, native livekit-plugins-sarvam package - same shape
as the existing cartesia/elevenlabs branches, not an OpenAI-compat
shim. Added 2026-07-15.

Run: python3 -m pytest agent-template/tests/test_plugins_tts.py
  or: python3 agent-template/tests/test_plugins_tts.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest
from config import settings
from agent.plugins import _create_primary_tts


def test_sarvam_missing_key_raises(monkeypatch):
    monkeypatch.delenv("SARVAM_API_KEY", raising=False)
    monkeypatch.setattr(settings, "tts_provider", "sarvam")
    monkeypatch.setattr(settings, "sarvam_api_key", "")
    with pytest.raises(ValueError, match="Sarvam API key is required"):
        _create_primary_tts()


def test_sarvam_builds_client_with_default_voice(monkeypatch):
    monkeypatch.setattr(settings, "tts_provider", "sarvam")
    monkeypatch.setattr(settings, "sarvam_api_key", "test-key-123")
    monkeypatch.setattr(settings, "tts_voice", "")

    result = _create_primary_tts()

    assert result._api_key == "test-key-123"
    assert result._opts.speaker == "anushka"


def test_sarvam_respects_tts_voice_override(monkeypatch):
    monkeypatch.setattr(settings, "tts_provider", "sarvam")
    monkeypatch.setattr(settings, "sarvam_api_key", "test-key-123")
    monkeypatch.setattr(settings, "tts_voice", "hitesh")

    result = _create_primary_tts()

    assert result._api_key == "test-key-123"
    assert result._opts.speaker == "hitesh"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
