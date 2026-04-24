"""STT, TTS, and LLM plugin factories using LiveKit FallbackAdapters.

Primary providers are user-configurable (gpu-ai, deepgram, etc.).
Fallback providers (Deepgram STT, OpenAI LLM, Cartesia TTS) activate
automatically at runtime if the primary fails mid-operation — not just
at startup. This uses LiveKit's built-in FallbackAdapter pattern.
"""

import logging
import re
import httpx
from livekit.agents import inference
from livekit.agents.llm import FallbackAdapter as FallbackLLMAdapter
from livekit.agents.stt import FallbackAdapter as FallbackSTTAdapter
from livekit.agents.tts import FallbackAdapter as FallbackTTSAdapter
from config import settings

logger = logging.getLogger("plugins")


def _gpu_ai_base_url() -> str:
    """Return the OpenAI-compatible GPU-AI base URL without the MCP path."""
    return settings.gpu_ai_mcp_url.removesuffix("/mcp").rstrip("/")


def _gpu_ai_llm_base_url() -> str:
    """Return the OpenAI-compatible LLM base URL."""
    return settings.gpu_ai_llm_base_url.removesuffix("/").removesuffix("/v1") + "/v1"


def _gpu_ai_stt_base_url() -> str:
    """Return the OpenAI-compatible STT base URL."""
    return settings.gpu_ai_stt_base_url.removesuffix("/").removesuffix("/v1") + "/v1"


def _gpu_ai_tts_base_url() -> str:
    """Return the OpenAI-compatible TTS base URL."""
    return settings.gpu_ai_tts_base_url.removesuffix("/").removesuffix("/v1") + "/v1"


def _gpu_ai_model_name(model: str | None, default: str) -> str:
    """Use raw model ids when calling the in-cluster OpenAI-compatible endpoint."""
    return (model or default).removeprefix("openai-proxy/")


def _gpu_ai_tts_voice(voice: str | None) -> str:
    """Map retired UI aliases to voices currently exposed by the audio gateway."""
    if not voice:
        return "aditya"
    legacy_aliases = {
        "Indic-Parler-English-Male": "Ash",
        "Indic-Parler-English-Female": "Alloy",
        "Indic-Parler-Hindi-Male": "aditya",
        "Indic-Parler-Hindi-Female": "roopa",
    }
    if voice in legacy_aliases:
        return legacy_aliases[voice]
    if re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", voice):
        logger.warning("Retired UUID TTS voice %s detected; using aditya", voice)
        return "aditya"
    return voice


# ── LLM ──────────────────────────────────────────────────────────

def create_llm_with_fallback():
    """Create primary LLM with runtime fallback to OpenAI.

    Uses FallbackAdapter: if primary fails mid-conversation (not just at init),
    it automatically switches to the fallback model.
    """
    from livekit.plugins import openai as openai_plugin

    primary = _create_primary_llm()
    fallbacks = []

    if settings.openai_api_key:
        fallbacks.append(openai_plugin.LLM(
            model="gpt-4o-mini",
            api_key=settings.openai_api_key,
        ))

    if not fallbacks:
        return primary

    return FallbackLLMAdapter(llm=[primary, *fallbacks])


def _create_primary_llm():
    """Create the primary (fast) LLM for voice conversation."""
    from livekit.plugins import openai as openai_plugin

    provider = settings.llm_provider
    if provider in {"letta", "dify"}:
        logger.warning(
            "LLM provider %s is not a realtime voice provider; using gpu-ai primary LLM",
            provider,
        )
        provider = "gpu-ai"

    if provider == "gpu-ai":
        base_url = _gpu_ai_llm_base_url()
        # External gateway (mcp.baisoln.com) enforces Kong key-auth via
        # X-API-Key header. In-cluster path is unauthenticated. Pass the
        # key both ways so a single config works for both.
        key = settings.gpu_ai_key or "not-needed"
        extra_headers = (
            {"X-API-Key": settings.gpu_ai_key} if settings.gpu_ai_key else {}
        )
        return openai_plugin.LLM(
            model=_gpu_ai_model_name(settings.llm_model, "qwen3.6-35b-a3b-fp8"),
            base_url=base_url,
            api_key=key,
            extra_headers=extra_headers,
            timeout=httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0),
        )

    if provider == "openai":
        if not settings.openai_api_key:
            raise ValueError("OpenAI API key not configured")
        return openai_plugin.LLM(
            model=settings.llm_model or "gpt-4o-mini",
            api_key=settings.openai_api_key,
        )

    if provider == "custom":
        if not settings.custom_llm_base_url:
            raise ValueError("Custom LLM base URL not configured")
        return openai_plugin.LLM(
            model=settings.llm_model or "default",
            base_url=settings.custom_llm_base_url,
            api_key=settings.custom_llm_api_key or "not-needed",
            timeout=httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0),
        )

    logger.warning("Unknown LLM provider %s; using gpu-ai primary LLM", provider)
    provider = "gpu-ai"
    base_url = _gpu_ai_llm_base_url()
    key = settings.gpu_ai_key or "not-needed"
    extra_headers = (
        {"X-API-Key": settings.gpu_ai_key} if settings.gpu_ai_key else {}
    )
    return openai_plugin.LLM(
        model=_gpu_ai_model_name(settings.llm_model, "qwen3.6-35b-a3b-fp8"),
        base_url=base_url,
        api_key=key,
        extra_headers=extra_headers,
        timeout=httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0),
    )


# Legacy aliases for backward compatibility
create_primary_llm = _create_primary_llm


def create_fallback_llm():
    """Standalone fallback LLM: OpenAI gpt-4o-mini."""
    from livekit.plugins import openai as openai_plugin

    if not settings.openai_api_key:
        raise RuntimeError("Fallback LLM requires OPENAI_API_KEY in Vault")
    return openai_plugin.LLM(model="gpt-4o-mini", api_key=settings.openai_api_key)


# ── STT ──────────────────────────────────────────────────────────

def create_stt_with_fallback():
    """Create primary STT with runtime fallback to Deepgram/OpenAI."""
    primary = _create_primary_stt()
    fallbacks = []

    if settings.deepgram_api_key:
        from livekit.plugins import deepgram
        fallbacks.append(deepgram.STT(api_key=settings.deepgram_api_key))

    if settings.openai_api_key:
        from livekit.plugins import openai as openai_plugin
        fallbacks.append(openai_plugin.STT(
            model="whisper-1",
            api_key=settings.openai_api_key,
        ))

    if not fallbacks:
        return primary

    return FallbackSTTAdapter(stt=[primary, *fallbacks])


def _create_primary_stt():
    """Create STT plugin based on configuration."""
    provider = settings.stt_provider
    if provider in {"", "whisper"}:
        provider = "gpu-ai"

    if provider in ("gpu-ai", "faster-whisper"):
        from livekit.plugins import openai as openai_plugin
        key = settings.gpu_ai_key or "not-needed"
        return openai_plugin.STT(
            model=settings.stt_model or "whisper-1",
            base_url=_gpu_ai_stt_base_url(),
            api_key=key,
        )

    if provider == "deepgram":
        from livekit.plugins import deepgram
        return deepgram.STT(api_key=settings.deepgram_api_key or None)

    if provider == "openai":
        from livekit.plugins import openai as openai_plugin
        return openai_plugin.STT(
            model=settings.stt_model or "whisper-1",
            api_key=settings.openai_api_key or None,
        )

    logger.warning("Unknown STT provider %s; using gpu-ai STT", provider)
    from livekit.plugins import openai as openai_plugin
    return openai_plugin.STT(
        model=settings.stt_model or "whisper-1",
        base_url=_gpu_ai_stt_base_url(),
        api_key=settings.gpu_ai_key or "not-needed",
    )


# Legacy aliases
create_stt = _create_primary_stt


def create_fallback_stt():
    """Standalone fallback STT."""
    if settings.deepgram_api_key:
        from livekit.plugins import deepgram
        return deepgram.STT(api_key=settings.deepgram_api_key)
    if settings.openai_api_key:
        from livekit.plugins import openai as openai_plugin
        return openai_plugin.STT(model="whisper-1", api_key=settings.openai_api_key)
    raise RuntimeError("No fallback STT available")


# ── TTS ──────────────────────────────────────────────────────────

def create_tts_with_fallback():
    """Create primary TTS with runtime fallback to Cartesia/OpenAI."""
    primary = _create_primary_tts()
    fallbacks = []

    if settings.cartesia_api_key:
        try:
            from livekit.plugins import cartesia
            fallbacks.append(cartesia.TTS(api_key=settings.cartesia_api_key))
        except ImportError:
            pass

    if settings.openai_api_key:
        from livekit.plugins import openai as openai_plugin
        fallbacks.append(openai_plugin.TTS(
            model="tts-1",
            voice="alloy",
            api_key=settings.openai_api_key,
        ))

    if not fallbacks:
        return primary

    return FallbackTTSAdapter(tts=[primary, *fallbacks])


def _create_primary_tts():
    """Create TTS plugin based on configuration."""
    provider = settings.tts_provider
    if provider in {"", "indextts", "indextts2"}:
        provider = "gpu-ai"

    if provider == "gpu-ai":
        # gpu-ai's /audio/speech returns raw WAV/MP3, not OpenAI SSE —
        # use our custom adapter instead of openai.TTS (which would try
        # the SSE path for any model name other than "tts-1"/"tts-1-hd"
        # and fail with "no audio frames were pushed"). Pattern lifted
        # from livekit-plugins/flashhead/examples/tools/local_tts.py.
        from agent.gpu_ai_tts import GpuAiTTS
        return GpuAiTTS(
            base_url=_gpu_ai_tts_base_url(),
            api_key=settings.gpu_ai_key or "not-needed",
            model="indextts2",
            voice=_gpu_ai_tts_voice(settings.tts_voice),
        )

    if provider == "cartesia":
        from livekit.plugins import cartesia
        return cartesia.TTS(
            api_key=settings.cartesia_api_key or None,
            voice=settings.tts_voice or "default",
        )

    if provider == "openai":
        from livekit.plugins import openai as openai_plugin
        return openai_plugin.TTS(
            model="tts-1",
            voice=settings.tts_voice or "alloy",
            api_key=settings.openai_api_key or None,
        )

    if provider == "elevenlabs":
        from livekit.plugins import elevenlabs
        return elevenlabs.TTS(voice=settings.tts_voice or "default")

    logger.warning("Unknown TTS provider %s; using gpu-ai TTS", provider)
    from agent.gpu_ai_tts import GpuAiTTS
    return GpuAiTTS(
        base_url=_gpu_ai_tts_base_url(),
        api_key=settings.gpu_ai_key or "not-needed",
        model="indextts2",
        voice=_gpu_ai_tts_voice(settings.tts_voice),
    )


# Legacy aliases
create_tts = _create_primary_tts


def create_fallback_tts():
    """Standalone fallback TTS."""
    if settings.cartesia_api_key:
        try:
            from livekit.plugins import cartesia
            return cartesia.TTS(api_key=settings.cartesia_api_key)
        except ImportError:
            pass
    if settings.openai_api_key:
        from livekit.plugins import openai as openai_plugin
        return openai_plugin.TTS(model="tts-1", voice="alloy", api_key=settings.openai_api_key)
    raise RuntimeError("No fallback TTS available")
