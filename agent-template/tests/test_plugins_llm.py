"""Regression tests for the Gemini LLM provider branch in plugins.py.

Gemini is wired in via its OpenAI-compatible endpoint (same shape as the
openrouter branch) — no livekit-plugins-google dependency needed. Added
2026-07-15.

Run: python3 -m pytest agent-template/tests/test_plugins_llm.py
  or: python3 agent-template/tests/test_plugins_llm.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest
from config import settings
from agent.plugins import _create_primary_llm


def test_gemini_missing_key_raises(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.setattr(settings, "llm_provider", "gemini")
    with pytest.raises(ValueError, match="Gemini API key not configured"):
        _create_primary_llm()


def test_gemini_builds_openai_compatible_client_with_default_model(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-123")
    monkeypatch.setattr(settings, "llm_provider", "gemini")
    monkeypatch.setattr(settings, "llm_model", "")

    result = _create_primary_llm()

    assert result.model == "gemini-2.5-flash"
    assert result.provider == "generativelanguage.googleapis.com"


def test_gemini_respects_llm_model_override(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-123")
    monkeypatch.setattr(settings, "llm_provider", "gemini")
    monkeypatch.setattr(settings, "llm_model", "gemini-2.5-pro")

    result = _create_primary_llm()

    assert result.model == "gemini-2.5-pro"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
