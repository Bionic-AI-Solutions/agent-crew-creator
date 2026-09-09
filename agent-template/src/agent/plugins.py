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

    if provider == "gemini":
        # Gemini's OpenAI-compatible endpoint — same shape as openrouter.
        # Key is injected as GEMINI_API_KEY env var by
        # agentDeployer.providerEnvName, sourced via secretKeyRef from
        # the per-namespace Secret (see k8sClient.ts), which is kept in
        # sync with Vault secret/shared/api-keys:gemini_api_key (or a
        # per-agent override) by an ExternalSecret on a 5-minute
        # refresh interval — rotating the key only requires a pod
        # restart, not a redeploy.
        import os
        api_key = os.environ.get("GEMINI_API_KEY", "")
        if not api_key:
            raise ValueError("Gemini API key not configured (expected GEMINI_API_KEY env)")
        # Thinking OFF by default. Gemini 2.5 runs an internal reasoning pass
        # before emitting a token, and the user waits through all of it in
        # silence -- time-to-first-token, not throughput, is what a voice turn
        # is judged on. Measured on a live jarvis session: TTFT reached 11.7s
        # with reported throughput collapsing to 3.9 tok/s, because the tokens
        # being spent were thinking tokens that never reach the caller. A
        # trivial prompt still burned 75 of them; a 3k-token prompt carrying a
        # screenshare frame burns far more.
        #
        # GEMINI_REASONING_EFFORT re-enables it for an agent that would rather
        # think than answer quickly ("minimal" | "low" | "medium" | "high").
        # Anything the OpenAI schema does not accept is ignored with a warning
        # rather than crashing the worker at startup.
        effort = os.environ.get("GEMINI_REASONING_EFFORT", "none").strip().lower()
        if effort not in ("none", "minimal", "low", "medium", "high", "xhigh", "max"):
            logger.warning(
                "GEMINI_REASONING_EFFORT=%r is not a valid effort; using 'none'", effort)
            effort = "none"
        return openai_plugin.LLM(
            model=settings.llm_model or "gemini-2.5-flash",
            base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
            api_key=api_key,
            reasoning_effort=effort,
            timeout=httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0),
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

    if provider == "sarvam":
        # Native livekit-plugins-sarvam — same shape as cartesia/
        # elevenlabs above, not an OpenAI-compat shim. Key is injected
        # as SARVAM_API_KEY env var by agentDeployer.providerEnvName,
        # sourced via secretKeyRef from the per-namespace Secret (see
        # k8sClient.ts), kept in sync with Vault
        # secret/shared/api-keys:SARVAM_API_KEY (exact uppercase — or a
        # per-agent override) by an ExternalSecret on a 5-minute
        # refresh interval — rotating the key only requires a pod
        # restart, not a redeploy.
        #
        # model pinned to "bulbul:v2": the plugin's own default model
        # is "bulbul:v3", but "bulbul:v3" validates speaker/model
        # compatibility and does NOT include "anushka" (our default
        # voice) or other legacy speaker names in its allowed set —
        # only "bulbul:v2" does. Verified against the installed
        # livekit-plugins-sarvam==1.6.5 (MODEL_SPEAKER_COMPATIBILITY).
        from livekit.plugins import sarvam
        return sarvam.TTS(
            model="bulbul:v2",
            speaker=settings.tts_voice or "anushka",
            # Sarvam requires an explicit target language — it does not
            # auto-detect from the synthesized text. Defaults to en-IN
            # (the plugin's own default) when unset, matching every
            # agent that predates this setting.
            target_language_code=settings.tts_language or "en-IN",
            api_key=settings.sarvam_api_key or None,
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
# IMPORTANT: the streaming path returns audio at the engine's NATIVE sample
# rate, never resampled, and the engines do not agree on one. Getting this
# number wrong is not a subtle defect: LiveKit builds a resampler from the
# rate we declare to the room's 48 kHz (voice/generation.py), so declaring
# 22050 for a 24000 Hz stream stretches every utterance by 8.84% and pitches
# it down ~1.5 semitones, while the producer outruns the consumer and the
# surplus is dropped as clicks and breaks.
#
# This used to be guessed from substrings in the voice name, which was wrong
# for 154 of the gateway's 191 voices. The gateway publishes the authoritative
# engine for each voice on /v1/audio/voices, so we ask it instead.
import os
import struct
from typing import NamedTuple
import httpx as _httpx_streaming  # avoid name clash with module-level httpx
from livekit import rtc
from livekit.agents import tts as _lk_tts
from livekit.agents import APIConnectOptions, DEFAULT_API_CONNECT_OPTIONS


# Measured against the live gateway on 2026-09-09 by reading the `fmt ` chunk
# of each engine's own output; see _parse_wav_header for the verification path
# that keeps this table honest at runtime.
_ENGINE_SAMPLE_RATES: dict[str, int] = {
    # Read from each engine's own `fmt ` chunk against the live gateway,
    # 2026-09-09. These five are what /v1/audio/voices actually serves.
    "omnivoice": 24000,
    "kokoro": 24000,
    "openai": 24000,
    "elevenlabs": 24000,
    "sarvam": 22050,
    # Carried over from the voice-name heuristic this table replaced. The
    # gateway serves none of them today, so they are UNVERIFIED -- kept only
    # so that an engine returning would not silently fall to the default.
    # Measure before trusting any of these.
    "indextts2": 22050,
    "f5": 24000,
    "parler": 24000,
}

# 4 of the 5 engines the gateway serves are 24000, so an unrecognised voice is
# far likelier to be 24000 than 22050 -- the old default, which was chosen when
# IndexTTS-2 was the only engine.
_DEFAULT_SAMPLE_RATE = 24000

# voice id -> engine, fetched once per worker process.
_voice_engine_cache: dict[str, str] | None = None


def prewarm_voice_registry(base_url: str) -> None:
    """Populate the voice -> engine cache. Blocking; call before any job.

    This is deliberately NOT done on demand. The lookup sits on the path of
    _GpuAiStreamingTTS.__init__, which create_tts_with_fallback() calls
    synchronously from inside the job's event loop -- so a blocking httpx.get
    there stops the whole loop, measured at 3.02s to timeout against an
    unroutable host with no other coroutine making progress for the duration.
    A failed fetch is not cached, so it would have cost that on *every*
    session for as long as the gateway stayed down: a 3s freeze at session
    start, during exactly the outage that caused it.

    Running here instead means the cost is paid once, in the worker process,
    before any room is joined. If it fails, nothing blocks -- the name
    heuristic takes over, and _run resamples if that guess turns out wrong.
    """
    global _voice_engine_cache
    if _voice_engine_cache is not None:
        return
    try:
        resp = _httpx_streaming.get(f"{base_url}/audio/voices", timeout=5.0)
        resp.raise_for_status()
        mapping = {}
        for entry in resp.json()["data"]["voices"]:
            vid, engine = entry.get("id"), entry.get("engine")
            if vid and engine:
                mapping[vid.lower()] = engine.lower()
    except Exception as e:
        logger.warning("could not prewarm the gpu-ai voice registry (%s); "
                       "sample rates will be guessed from voice names", e)
        return
    _voice_engine_cache = mapping
    logger.info("gpu-ai voice registry: %d voices across %d engines",
                len(mapping), len(set(mapping.values())))


def _sample_rate_from_voice_name(voice: str) -> int:
    """Last-resort guess when the gateway registry is unavailable."""
    v = (voice or "").lower()
    if "indextts" in v:
        return 22050
    if v.endswith("-svm") or "sarvam" in v:
        return 22050
    if "f5-tts" in v or "f5tts" in v or "parler" in v:
        return 24000
    return _DEFAULT_SAMPLE_RATE


def _engine_sample_rate_for_voice(voice: str, base_url: str | None = None) -> int:
    """Native sample rate of the engine that serves `voice`.

    Reads only the cache prewarm_voice_registry() filled; never does I/O,
    because every caller is on an event loop that must not block.
    """
    if base_url and _voice_engine_cache:
        engine = _voice_engine_cache.get((voice or "").lower())
        if engine:
            rate = _ENGINE_SAMPLE_RATES.get(engine)
            if rate:
                return rate
            logger.warning("gpu-ai engine %r has no known sample rate; assuming %d",
                           engine, _DEFAULT_SAMPLE_RATE)
            return _DEFAULT_SAMPLE_RATE
    return _sample_rate_from_voice_name(voice)


class _UnusableGpuAiResponse(RuntimeError):
    """The gateway answered, but not with audio we can play.

    Raised rather than logged because FallbackAdapter only moves to the next
    engine when synthesize() raises; swallowing it leaves the turn silent.
    """


class _WavFormat(NamedTuple):
    sample_rate: int
    num_channels: int
    bits_per_sample: int
    data_offset: int


# A RIFF header is only 44 bytes when it carries nothing but `fmt ` and `data`.
# The gateway's kokoro path muxes through ffmpeg, which inserts a 26-byte
# LIST/INFO chunk ("Lavf62.3.100"), putting `data` at offset 78 -- so the old
# hardcoded 44 pushed 34 bytes of chunk headers and ASCII into the audio as 17
# samples of noise at the head of every kokoro utterance.
_WAV_MAX_HEADER_BYTES = 4096


def _parse_wav_header(buf: bytes) -> _WavFormat | None:
    """Walk RIFF chunks for `fmt ` and the start of `data`.

    Returns None while more bytes are still needed, and raises ValueError if
    this is not a WAVE stream or the chunk structure is unusable.
    """
    if len(buf) < 12:
        return None
    if buf[0:4] != b"RIFF" or buf[8:12] != b"WAVE":
        raise ValueError(f"not a RIFF/WAVE stream: {buf[:12]!r}")

    pos, fmt = 12, None
    while True:
        if pos + 8 > len(buf):
            return None
        chunk_id = buf[pos : pos + 4]
        chunk_size = struct.unpack_from("<I", buf, pos + 4)[0]
        body = pos + 8
        if chunk_id == b"fmt ":
            if body + 16 > len(buf):
                return None
            _, channels, rate, _, _, bits = struct.unpack_from("<HHIIHH", buf, body)
            fmt = (channels, rate, bits)
        elif chunk_id == b"data":
            if fmt is None:
                raise ValueError("WAVE stream has a data chunk before its fmt chunk")
            channels, rate, bits = fmt
            return _WavFormat(rate, channels, bits, body)
        # The streaming endpoint writes 0xFFFFFFFF as a placeholder size on the
        # chunk it is still filling. That is expected on `data` (handled above)
        # but leaves us nowhere to seek to on anything else.
        if chunk_size == 0xFFFFFFFF:
            raise ValueError(f"unbounded {chunk_id!r} chunk before data")
        pos = body + chunk_size + (chunk_size & 1)  # chunks are word-aligned
        if pos > _WAV_MAX_HEADER_BYTES:
            raise ValueError("no data chunk within the first "
                             f"{_WAV_MAX_HEADER_BYTES} bytes")


class _GpuAiStreamingTTS(_lk_tts.TTS):
    """Streaming TTS that talks to mcp-api-server with stream=true."""

    def __init__(self, *, base_url: str, voice: str, model: str = "tts-1") -> None:
        sr = _engine_sample_rate_for_voice(voice, base_url)
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

                # The upstream streams a progressive WAV: a RIFF header, then
                # raw PCM flushed per sentence. Initialization is deferred
                # until the header has actually arrived so the emitter can be
                # told what the stream really is rather than what we guessed.
                #
                # We still declare self._tts._sample_rate rather than the
                # header's rate. FallbackAdapter builds its own resampler from
                # the CLASS-level tts.sample_rate, fixed once at its
                # construction, and forwards our frames' raw bytes
                # (tts/fallback_adapter.py) -- it never learns what an inner
                # emitter declared per stream. So the bytes leaving here have
                # to actually be at the class-level rate, whatever the header
                # says. The header's job is to VERIFY that rate, and to drive
                # a resample when the engine->rate table turns out wrong.
                started = False
                head = b""
                resampler: rtc.AudioResampler | None = None
                declared = self._tts._sample_rate
                channels = 1
                carry = b""

                def _emit(pcm: bytes) -> None:
                    nonlocal carry
                    if resampler is None:
                        # AudioByteStream inside the emitter already buffers a
                        # partial trailing sample across pushes, so a chunk
                        # that ends mid-sample is safe here. The gateway does
                        # emit them: 40 of openai's 47 chunks were odd-length.
                        output_emitter.push(pcm)
                        return
                    # AudioResampler.push needs whole frames, so the partial
                    # trailing sample has to be carried by hand -- dropping it
                    # would shift every following sample by one byte.
                    pcm = carry + pcm
                    usable = len(pcm) - (len(pcm) % (2 * channels))
                    carry = pcm[usable:]
                    if usable <= 0:
                        return
                    frame = rtc.AudioFrame(
                        data=pcm[:usable],
                        sample_rate=fmt.sample_rate,
                        num_channels=channels,
                        samples_per_channel=usable // (2 * channels),
                    )
                    for out in resampler.push(frame):
                        output_emitter.push(out.data.tobytes())

                async for chunk in resp.aiter_bytes():
                    if not chunk:
                        continue
                    if started:
                        _emit(chunk)
                        continue

                    head += chunk
                    try:
                        fmt = _parse_wav_header(head)
                    except ValueError as e:
                        # Something other than the WAV we asked for. Failing
                        # loudly lets FallbackAdapter move to the next engine,
                        # which beats emitting a burst of noise.
                        raise _UnusableGpuAiResponse(
                            f"gpu-ai TTS returned a stream we cannot read: {e}"
                        ) from e
                    if fmt is None:
                        continue

                    if fmt.bits_per_sample != 16:
                        raise _UnusableGpuAiResponse(
                            f"gpu-ai TTS returned {fmt.bits_per_sample}-bit audio; "
                            "audio/pcm frames must be 16-bit"
                        )

                    # A WAVE header is not proof of PCM contents. The gateway's
                    # elevenlabs path answers response_format=wav with a PCM
                    # `fmt ` chunk wrapped around an MP3 bitstream, which as
                    # PCM is full-scale noise. Refusing lets FallbackAdapter
                    # reach a working engine.
                    #
                    # Only the ID3 magic is tested, deliberately. Testing the
                    # bare MPEG sync word (0xFF then three set bits) as well
                    # looks more thorough and is much worse: 32 of the 65536
                    # int16 values encode to those two bytes, and one of them
                    # is -1, which is what dithered near-silence looks like.
                    # That check refused roughly one valid utterance in two
                    # thousand, biased toward quiet openings -- trading a bug
                    # that makes 37 voices noisy for one that randomly drops
                    # replies on all 191. All three elevenlabs voices sampled
                    # lead with ID3, so this catches the real defect; an MP3
                    # with no ID3 tag would still slip through to noise, which
                    # is where the gateway needs the actual fix.
                    if len(head) < fmt.data_offset + 3:
                        continue
                    if head[fmt.data_offset : fmt.data_offset + 3] == b"ID3":
                        raise _UnusableGpuAiResponse(
                            f"gpu-ai TTS voice {self._tts._voice!r} returned an MPEG "
                            "bitstream inside a WAVE header, not PCM"
                        )
                    # sample_rate gets a correction path below; channels
                    # cannot have one. FallbackAdapter fixes num_channels once
                    # at construction from the class-level attribute and only
                    # ever resamples for a RATE mismatch, so stereo forwarded
                    # under a mono declaration would reach the room as
                    # half-duration interleaved noise with nothing to catch it.
                    # Every engine the gateway serves is mono; if that changes,
                    # this needs a real downmix, not a silent reinterpretation.
                    # (Also makes the `2 * channels` arithmetic below safe --
                    # a malformed fmt claiming 0 channels would divide by zero.)
                    if fmt.num_channels != 1:
                        raise _UnusableGpuAiResponse(
                            f"gpu-ai TTS returned {fmt.num_channels}-channel audio; "
                            "only mono is supported"
                        )

                    if fmt.sample_rate != declared:
                        # The engine->rate table disagrees with the engine.
                        # Resample so this reply still sounds right, and say so
                        # loudly -- this is the exact condition that shipped as
                        # 8.84% pitch-shifted, dropout-ridden audio.
                        logger.error(
                            "gpu-ai TTS voice %r: declared %d Hz but the stream is %d Hz; "
                            "resampling. Update _ENGINE_SAMPLE_RATES.",
                            self._tts._voice, declared, fmt.sample_rate,
                        )
                        resampler = rtc.AudioResampler(
                            input_rate=fmt.sample_rate,
                            output_rate=declared,
                            num_channels=channels,
                        )

                    output_emitter.initialize(
                        request_id=resp.headers.get("x-request-id", ""),
                        sample_rate=declared,
                        num_channels=channels,
                        mime_type="audio/pcm",
                    )
                    started = True
                    _emit(head[fmt.data_offset :])
                    head = b""

                if not started:
                    # push()/flush() raise if initialize() was never reached.
                    logger.error("gpu-ai TTS returned no audio for %r", self._tts._voice)
                    return
                if resampler is not None:
                    for out in resampler.flush():
                        output_emitter.push(out.data.tobytes())
                output_emitter.flush()
        except _UnusableGpuAiResponse:
            # Deliberate: propagate so FallbackAdapter reaches a working engine
            # instead of the turn ending in silence.
            raise
        except _httpx_streaming.TimeoutException:
            logger.error("gpu-ai TTS timed out")
        except Exception as e:
            logger.error("gpu-ai TTS failed: %s", e)
