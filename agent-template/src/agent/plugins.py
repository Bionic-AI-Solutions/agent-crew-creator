"""STT, TTS, and LLM plugin factories using LiveKit FallbackAdapters.

Primary providers are user-configurable (gpu-ai, deepgram, etc.).
Fallback providers (Deepgram STT, OpenAI LLM, Cartesia TTS) activate
automatically at runtime if the primary fails mid-operation — not just
at startup. This uses LiveKit's built-in FallbackAdapter pattern.
"""

import logging
import httpx
from livekit.agents import inference
from livekit.agents.llm import FallbackAdapter as FallbackLLMAdapter
from livekit.agents.stt import FallbackAdapter as FallbackSTTAdapter
from livekit.agents.tts import FallbackAdapter as FallbackTTSAdapter
from config import settings

logger = logging.getLogger("plugins")


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

    if provider == "gpu-ai":
        # Internal cluster GPU — no auth required within cluster.
        # gpu_ai_llm_url is the OpenAI-compatible endpoint (mcp-api-server),
        # NOT the MCP protocol endpoint.
        base_url = settings.gpu_ai_llm_url.rstrip("/") + "/v1"
        return openai_plugin.LLM(
            model=settings.llm_model or "gemma-4-e4b-it",
            base_url=base_url,
            api_key="not-needed",
            timeout=httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0),
        )

    if provider == "openai":
        if not settings.openai_api_key:
            raise ValueError("OpenAI API key not configured")
        return openai_plugin.LLM(
            model=settings.llm_model or "gpt-4o-mini",
            api_key=settings.openai_api_key,
        )

    if provider == "openrouter":
        # OpenRouter is OpenAI-compatible. Key is injected as
        # OPENROUTER_API_KEY env var by agentDeployer.providerEnvName.
        import os
        api_key = os.environ.get("OPENROUTER_API_KEY", "")
        if not api_key:
            raise ValueError("OpenRouter API key not configured (expected OPENROUTER_API_KEY env)")
        return openai_plugin.LLM(
            model=settings.llm_model or "openai/gpt-4o-mini",
            base_url="https://openrouter.ai/api/v1",
            api_key=api_key,
            timeout=httpx.Timeout(connect=15.0, read=60.0, write=15.0, pool=15.0),
        )

    if provider == "anthropic":
        # Anthropic via the dedicated livekit plugin (not openai-compat).
        try:
            from livekit.plugins import anthropic as anthropic_plugin
        except ImportError as e:
            raise ValueError("livekit-plugins-anthropic not installed") from e
        import os
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            raise ValueError("Anthropic API key not configured (expected ANTHROPIC_API_KEY env)")
        return anthropic_plugin.LLM(
            model=settings.llm_model or "claude-3-5-sonnet-20241022",
            api_key=api_key,
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

    raise ValueError(f"Unknown LLM provider: {provider}")


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

    if provider in ("gpu-ai", "faster-whisper"):
        from livekit.plugins import openai as openai_plugin
        base_url = settings.gpu_ai_llm_url.rstrip("/")
        # api_key="not-needed" is required because the openai SDK validates
        # the api_key in its constructor (raises OpenAIError if unset).
        # Internal cluster GPU has no auth — but the SDK doesn't know that.
        return openai_plugin.STT(
            model=settings.stt_model or "whisper-1",
            base_url=f"{base_url}/v1",
            api_key="not-needed",
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

    raise ValueError(f"Unknown STT provider: {provider}")


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
    primary = None
    try:
        primary = _create_primary_tts()
    except (ValueError, ImportError) as e:
        logger.warning("Primary TTS (%s) failed to initialize: %s — using fallback",
                       settings.tts_provider, e)

    # AsyncAI is streaming-only — FallbackTTSAdapter uses synthesize()
    # which AsyncAI doesn't support. Return it directly without fallback.
    if settings.tts_provider == "async" and primary:
        return primary

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

    # gpu-ai TTS is always available on the cluster (no API key needed)
    if settings.tts_provider != "gpu-ai":
        try:
            fallbacks.append(_GpuAiStreamingTTS(
                base_url=settings.gpu_ai_llm_url.rstrip("/") + "/v1",
                voice=settings.tts_voice or "Sudhir-IndexTTS2",
                model=settings.tts_model or "tts-1",
            ))
        except Exception:
            pass

    tts_chain = [t for t in [primary, *fallbacks] if t is not None]
    if not tts_chain:
        raise RuntimeError(
            f"No TTS available: primary ({settings.tts_provider}) failed and "
            "no fallback providers could be initialized."
        )
    if len(tts_chain) == 1:
        return tts_chain[0]

    return FallbackTTSAdapter(tts=tts_chain)


def _create_primary_tts():
    """Create TTS plugin based on configuration."""
    provider = settings.tts_provider

    if provider == "gpu-ai":
        # Custom streaming TTS that hits mcp-api-server's /v1/audio/speech
        # with `stream=true` so the upstream IndexTTS-2 / F5-TTS engine
        # flushes per-sentence chunks instead of buffering the whole WAV.
        # Without this the openai-compat plugin opens the response in
        # streaming mode (iter_bytes) but never adds stream=true to the
        # JSON body, so the upstream synthesizes the entire utterance
        # before flushing — TTFB ≈ total time.
        return _GpuAiStreamingTTS(
            base_url=settings.gpu_ai_llm_url.rstrip("/") + "/v1",
            voice=settings.tts_voice or "Sudhir-IndexTTS2",
            model=settings.tts_model or "tts-1",
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
        return elevenlabs.TTS(
            voice_id=settings.tts_voice or "default",
            api_key=settings.elevenlabs_api_key or None,
        )

    if provider == "async":
        from livekit.plugins.asyncai import tts as asyncai_tts
        return asyncai_tts.TTS(
            api_key=settings.async_api_key or None,
            voice=settings.tts_voice or "e0f39dc4-f691-4e78-bba5-5c636692cc04",
        )

    raise ValueError(f"Unknown TTS provider: {provider}")


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


# ── Custom streaming TTS for the gpu-ai endpoint ────────────────
#
# The bionic gpu-ai TTS endpoint at mcp-api-server:8000/v1/audio/speech
# supports `stream=true` in the request body, which makes the upstream
# IndexTTS-2 / F5-TTS engine flush per-sentence chunks (one progressive
# WAV with placeholder size 0xFFFFFFFF, sentences yielded as they
# finish synthesizing).
#
# The stock livekit-plugins-openai TTS opens the response with
# `with_streaming_response.create(...)` which iter_bytes() the response
# body chunk by chunk — but it does NOT add `stream=true` to the JSON
# body. Result: TTFB ≈ total time, no per-sentence flushing.
#
# This subclass posts directly to /v1/audio/speech with stream=true and
# pushes the bytes into LiveKit's AudioEmitter as they arrive. The
# emitter parses the WAV header and emits PCM audio frames.
#
# IMPORTANT: IndexTTS-2 native sample rate is 22050 Hz (F5-TTS is
# 24000 Hz). The streaming path returns audio at the engine's native
# rate, NOT resampled. We tell the AudioEmitter the right rate based
# on the configured voice.
import os
import httpx as _httpx_streaming  # avoid name clash with module-level httpx
from livekit.agents import tts as _lk_tts
from livekit.agents import APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS


def _engine_sample_rate_for_voice(voice: str) -> int:
    """Map a voice id to the native sample rate of its TTS engine."""
    v = (voice or "").lower()
    # IndexTTS-2 voice clones (Sudhir-IndexTTS2, etc.)
    if "indextts" in v:
        return 22050
    # F5-TTS native rate
    if "f5" in v:
        return 24000
    # Indic Parler-TTS native rate (also 24000)
    if "parler" in v:
        return 24000
    # Default to IndexTTS-2 since that's the default voice in config.py
    return 22050


class _GpuAiStreamingTTS(_lk_tts.TTS):
    """Streaming TTS that talks to mcp-api-server with stream=true."""

    def __init__(self, *, base_url: str, voice: str, model: str = "tts-1") -> None:
        sr = _engine_sample_rate_for_voice(voice)
        super().__init__(
            capabilities=_lk_tts.TTSCapabilities(streaming=False),  # we use chunked, not realtime
            sample_rate=sr,
            num_channels=1,
        )
        self._base_url = base_url
        self._voice = voice
        self._model = model
        self._sample_rate = sr
        # Long total timeout — a 14s response can take 30s to fully stream
        # over the wire. Connect / write are fast.
        self._client = _httpx_streaming.AsyncClient(
            timeout=_httpx_streaming.Timeout(connect=15.0, read=120.0, write=15.0, pool=15.0),
            follow_redirects=True,
        )

    async def aclose(self) -> None:  # type: ignore[override]
        try:
            await self._client.aclose()
        except Exception:
            pass

    def synthesize(
        self,
        text: str,
        *,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> _lk_tts.ChunkedStream:
        return _GpuAiStreamingChunkedStream(
            tts=self,
            input_text=text,
            conn_options=conn_options,
        )


class _GpuAiStreamingChunkedStream(_lk_tts.ChunkedStream):
    """ChunkedStream that consumes a chunk-flushed WAV from gpu-ai TTS."""

    def __init__(
        self,
        *,
        tts: _GpuAiStreamingTTS,
        input_text: str,
        conn_options: APIConnectOptions,
    ) -> None:
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._tts: _GpuAiStreamingTTS = tts

    async def _run(self, output_emitter: _lk_tts.AudioEmitter) -> None:
        url = f"{self._tts._base_url}/audio/speech"
        body = {
            "model": self._tts._model,
            "voice": self._tts._voice,
            "input": self.input_text,
            "stream": True,
            "response_format": "wav",
        }
        try:
            async with self._tts._client.stream(
                "POST",
                url,
                json=body,
                headers={
                    "Authorization": "Bearer not-needed",
                    "Content-Type": "application/json",
                },
            ) as resp:
                if resp.status_code != 200:
                    text = (await resp.aread()).decode("utf-8", errors="replace")[:200]
                    logger.error("gpu-ai TTS HTTP %d: %s", resp.status_code, text)
                    return

                output_emitter.initialize(
                    request_id=resp.headers.get("x-request-id", ""),
                    sample_rate=self._tts._sample_rate,
                    num_channels=1,
                    mime_type="audio/pcm",
                )

                # The upstream streams a progressive WAV: 44-byte header
                # then raw PCM data flushed per-sentence. We strip the WAV
                # header and push only PCM frames so chunk boundaries don't
                # produce audible clicks from header bytes being interpreted
                # as audio samples.
                header_stripped = False
                buf = b""
                async for chunk in resp.aiter_bytes():
                    if not chunk:
                        continue
                    if not header_stripped:
                        buf += chunk
                        # WAV header is 44 bytes; wait until we have enough
                        if len(buf) < 44:
                            continue
                        # Skip the RIFF/WAV header, push remaining PCM
                        output_emitter.push(buf[44:])
                        buf = b""
                        header_stripped = True
                    else:
                        output_emitter.push(chunk)

                output_emitter.flush()
        except _httpx_streaming.TimeoutException:
            logger.error("gpu-ai TTS timed out")
        except Exception as e:
            logger.error("gpu-ai TTS failed: %s", e)
