"""End-to-end tests for the gpu-ai streaming TTS response handler.

The parser has its own tests (test_plugins_wav.py); this covers what the
_run loop does with it -- when it initializes the emitter, what it declares,
which bytes reach the audio, and how it behaves on the three malformed
responses the live gateway is known to produce.

Run: python3 -m pytest agent-template/tests/test_plugins_gpuai_stream.py
"""
import array
import asyncio
import os
import struct
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest
from agent import plugins
from config import settings
from agent.plugins import (
    _GpuAiStreamingChunkedStream,
    _GpuAiStreamingTTS,
    _UnusableGpuAiResponse,
)


def wav(sample_rate=24000, channels=1, bits=16, extra_chunks=b"", payload=b""):
    """Build a progressive WAV of the shape the gateway streams."""
    block = max(channels, 1) * bits // 8
    fmt = struct.pack("<HHIIHH", 1, channels, sample_rate,
                      sample_rate * block, block, bits)
    return (b"RIFF" + b"\xff" * 4 + b"WAVE"
            + b"fmt " + struct.pack("<I", len(fmt)) + fmt
            + extra_chunks
            + b"data" + b"\xff" * 4 + payload)


# ffmpeg's LIST/INFO chunk, exactly as the kokoro path emits it.
LAVF_LIST = b"LIST" + struct.pack("<I", 26) + b"INFOISFT" + struct.pack("<I", 13) + b"Lavf62.3.100\x00\x00"


class FakeEmitter:
    """Mirrors the real AudioEmitter's started/not-started contract."""

    def __init__(self):
        self.started = False
        self.init_kwargs = None
        self.pushed = []
        self.flushes = 0

    def initialize(self, **kwargs):
        if self.started:
            raise RuntimeError("AudioEmitter already started")
        self.started = True
        self.init_kwargs = kwargs

    def push(self, data):
        if not self.started:
            raise RuntimeError("AudioEmitter isn't started")
        self.pushed.append(data)

    def flush(self):
        if not self.started:
            raise RuntimeError("AudioEmitter isn't started")
        self.flushes += 1

    @property
    def audio(self):
        return b"".join(self.pushed)


class FakeResponse:
    def __init__(self, chunks, status_code=200):
        self._chunks = chunks
        self.status_code = status_code
        self.headers = {"x-request-id": "req-1"}

    async def aiter_bytes(self):
        for chunk in self._chunks:
            yield chunk

    async def aread(self):
        return b"".join(self._chunks)


class FakeClient:
    def __init__(self, response):
        self._response = response

    def stream(self, *_args, **_kwargs):
        response = self._response

        class _Ctx:
            async def __aenter__(self):
                return response

            async def __aexit__(self, *_exc):
                return False

        return _Ctx()


def build_tts(monkeypatch, voice="Eric-ov", engine="omnivoice"):
    """A TTS whose declared rate comes from a stubbed voice registry."""
    monkeypatch.setattr(plugins, "_voice_engine_cache", {voice.lower(): engine})
    return _GpuAiStreamingTTS(base_url="http://gateway/v1", voice=voice)


def run_stream(tts, chunks):
    """Drive _run directly, bypassing ChunkedStream's task machinery."""
    emitter = FakeEmitter()
    stub = types.SimpleNamespace(_tts=tts, input_text="hello")
    asyncio.run(_GpuAiStreamingChunkedStream._run(stub, emitter))
    return emitter


def run_with_body(monkeypatch, body_chunks, **tts_kwargs):
    tts = build_tts(monkeypatch, **tts_kwargs)
    tts._client = FakeClient(FakeResponse(body_chunks))
    return tts, run_stream(tts, body_chunks)


# ── the rate that used to be guessed ────────────────────────────

def test_declares_the_registry_rate_not_the_old_22050_default(monkeypatch):
    pcm = bytes(range(256)) * 4
    _tts, em = run_with_body(monkeypatch, [wav(24000, payload=pcm)])
    assert em.init_kwargs["sample_rate"] == 24000
    assert em.init_kwargs["num_channels"] == 1
    assert em.audio == pcm
    assert em.flushes == 1


def test_sarvam_still_gets_its_own_rate(monkeypatch):
    pcm = bytes(400)
    _tts, em = run_with_body(monkeypatch, [wav(22050, payload=pcm)],
                             voice="Aditya-svm", engine="sarvam")
    assert em.init_kwargs["sample_rate"] == 22050
    assert em.audio == pcm


# ── the header length that used to be hardcoded to 44 ───────────

@pytest.mark.parametrize("voice,engine,rate", [
    ("Alloy", "openai", 24000),
    ("Roger-el", "elevenlabs", 24000),
])
def test_registry_rate_reaches_the_emitter_for_every_served_engine(
    monkeypatch, voice, engine, rate
):
    """Rate mapping for engines no other stream test reaches.

    openai's real output is PCM, so this mirrors production. Elevenlabs' does
    not: the gateway answers with MP3 inside a WAVE header, which `_run`
    refuses at the ID3 check before any rate is declared, so its table entry
    is dead code in production today. The synthetic PCM payload here forward-
    guards the day that gateway bug is fixed -- it is not evidence that
    elevenlabs currently works through this path.
    """
    pcm = bytes(400)
    _tts, em = run_with_body(monkeypatch, [wav(rate, payload=pcm)],
                             voice=voice, engine=engine)
    assert em.init_kwargs["sample_rate"] == rate
    assert em.audio == pcm


def test_ffmpeg_list_chunk_does_not_leak_into_the_audio(monkeypatch):
    """The kokoro defect: `data` starts at 78, not 44."""
    pcm = bytes(range(200))
    body = wav(24000, extra_chunks=LAVF_LIST, payload=pcm)
    _tts, em = run_with_body(monkeypatch, [body], voice="af_alloy", engine="kokoro")
    assert em.audio == pcm
    assert b"Lavf" not in em.audio and b"data" not in em.audio
    # The old code pushed body[44:], which is 34 bytes longer.
    assert len(em.audio) == len(body) - 78


def test_header_split_across_chunks_is_reassembled(monkeypatch):
    """A header straddling a chunk boundary must not be misread."""
    pcm = bytes(range(128))
    body = wav(24000, extra_chunks=LAVF_LIST, payload=pcm)
    for cut in (3, 12, 30, 44, 60, 77, 78):
        chunks = [body[:cut], body[cut:]]
        _tts, em = run_with_body(monkeypatch, chunks, voice="af_alloy", engine="kokoro")
        assert em.audio == pcm, f"split at {cut} corrupted the audio"
        assert em.init_kwargs["sample_rate"] == 24000


# ── behaviour when the engine->rate table is wrong ──────────────

def test_rate_disagreement_is_resampled_to_the_declared_rate(monkeypatch, caplog):
    """The declared rate is what FallbackAdapter believes; honour it."""
    samples = 22050  # 1 second at the stream's real rate
    pcm = bytes(samples * 2)
    # Registry claims omnivoice/24000, the stream is really 22050.
    _tts, em = run_with_body(monkeypatch, [wav(22050, payload=pcm)])
    assert em.init_kwargs["sample_rate"] == 24000
    # ~1s resampled up to 24000 -> ~24000 samples -> ~48000 bytes.
    assert 47000 <= len(em.audio) <= 49000
    assert any("but the stream is 22050 Hz" in r.message for r in caplog.records)


def test_resampling_does_not_drop_odd_trailing_bytes(monkeypatch):
    """Chunk boundaries must not change the audio.

    Asserted as an identity against the same body delivered whole, because a
    tolerance on the output length is useless here: dropping one byte per
    seam moves the total by a handful of bytes in several thousand, which any
    plausible tolerance would wave through while the audio downstream of each
    seam is byte-swapped noise.
    """
    # A ramp, so a one-byte slip corrupts every following sample.
    pcm = bytes((i * 7) % 256 for i in range(4000))
    body = wav(22050, payload=pcm)  # 22050 != the declared 24000 -> resampled

    _tts, whole = run_with_body(monkeypatch, [body])
    # Odd-length chunks, as openai's path produces (40 of 47 chunks were odd).
    seams = [body[:45], body[45:1000], body[1000:2001], body[2001:3003], body[3003:]]
    _tts, split = run_with_body(monkeypatch, seams)

    # Not byte-identity: a resampler carries filter state, so where the input
    # is cut shifts the output by a couple of LSB. A dropped byte is a
    # different animal -- it swaps every following sample's high and low byte,
    # which moves values by thousands, not by two.
    a = array.array("h"); a.frombytes(whole.audio)
    b = array.array("h"); b.frombytes(split.audio)
    assert len(a) == len(b), f"seams changed the sample count: {len(a)} vs {len(b)}"
    assert len(a) > 1000
    worst = max(abs(x - y) for x, y in zip(a, b))
    assert worst <= 64, f"seams shifted the audio (worst sample delta {worst})"


# ── the three malformed responses the gateway actually returns ──

def test_mpeg_inside_a_wave_header_is_refused(monkeypatch):
    """The elevenlabs path answers response_format=wav with MP3."""
    body = wav(24000, payload=b"ID3\x04\x00\x00\x00\x00\x00#TSSE" + bytes(200))
    with pytest.raises(_UnusableGpuAiResponse, match="MPEG bitstream"):
        run_with_body(monkeypatch, [body], voice="Roger-el", engine="elevenlabs")


@pytest.mark.parametrize("first_sample", [-1, -257, -7937, -32768, 32767])
def test_quiet_opening_samples_are_not_mistaken_for_mpeg(monkeypatch, first_sample):
    """Valid PCM must never be refused because of what its first sample is.

    An earlier version of the guard also tested the bare MPEG sync word
    (0xFF followed by three set bits). 32 int16 values encode to those two
    bytes and one of them is -1 -- dithered near-silence -- so the guard
    dropped roughly one valid utterance in two thousand, biased toward the
    quiet openings that are most common.
    """
    pcm = struct.pack("<h", first_sample) + bytes(398)
    _tts, em = run_with_body(monkeypatch, [wav(24000, payload=pcm)])
    assert em.started, f"a valid utterance opening on {first_sample} was refused"
    assert em.audio == pcm


def test_registry_lookup_does_no_io(monkeypatch):
    """__init__ runs on the job's event loop; a blocking GET there froze it.

    Measured at 3.02s with no other coroutine progressing, repeated per
    session because failures are not cached. The map is prewarmed instead.
    """
    # Derived from BaseException on purpose: prewarm_voice_registry catches
    # Exception to stay best-effort, which would swallow an AssertionError
    # here and let the very thing under test pass unnoticed.
    class _BlockingIO(BaseException):
        pass

    def explode(*_a, **_kw):
        raise _BlockingIO("blocking HTTP call on the event loop")

    monkeypatch.setattr(plugins._httpx_streaming, "get", explode)
    monkeypatch.setattr(plugins, "_voice_engine_cache", None)
    tts = _GpuAiStreamingTTS(base_url="http://gateway/v1", voice="Shardul")
    # Cold cache falls back to the name heuristic rather than reaching out.
    assert tts.sample_rate == 24000


def test_prewarm_populates_the_cache(monkeypatch):
    class FakeResp:
        def raise_for_status(self): pass
        def json(self):
            return {"data": {"voices": [
                {"id": "Eric-ov", "engine": "omnivoice"},
                {"id": "Aditya-svm", "engine": "sarvam"},
            ]}}

    monkeypatch.setattr(plugins, "_voice_engine_cache", None)
    monkeypatch.setattr(plugins._httpx_streaming, "get", lambda *a, **k: FakeResp())
    plugins.prewarm_voice_registry("http://gateway/v1")
    try:
        assert plugins._engine_sample_rate_for_voice("Eric-ov", "http://gateway/v1") == 24000
        assert plugins._engine_sample_rate_for_voice("Aditya-svm", "http://gateway/v1") == 22050
    finally:
        plugins._voice_engine_cache = None


def test_prewarm_failure_is_not_cached_and_does_not_raise(monkeypatch):
    def boom(*_a, **_kw):
        raise OSError("gateway down")

    monkeypatch.setattr(plugins, "_voice_engine_cache", None)
    monkeypatch.setattr(plugins._httpx_streaming, "get", boom)
    plugins.prewarm_voice_registry("http://gateway/v1")
    assert plugins._voice_engine_cache is None


@pytest.mark.parametrize("cut", [0, 1, 2, 3])
def test_id3_detection_survives_a_chunk_boundary_inside_its_window(monkeypatch, cut):
    """The ID3 check needs 3 payload bytes; a seam inside them must wait.

    Without the `+ 3` lookahead the loop flips started=True on a truncated
    view, the short slice never equals b"ID3", and the whole MP3 streams
    through as PCM with nothing left to catch it. Mutating the lookahead to
    0 passed all 112 other tests, so this is the test that pins it.
    """
    body = wav(24000, payload=b"ID3\x04\x00\x00\x00\x00\x00#TSSE" + bytes(200))
    split = 44 + cut  # data_offset is 44 here; cut lands inside the ID3 magic
    with pytest.raises(_UnusableGpuAiResponse, match="MPEG bitstream"):
        run_with_body(monkeypatch, [body[:split], body[split:]],
                      voice="Roger-el", engine="elevenlabs")


def test_id3_detection_survives_byte_at_a_time_delivery(monkeypatch):
    body = wav(24000, payload=b"ID3\x04\x00\x00\x00\x00\x00#TSSE" + bytes(100))
    chunks = [body[i:i + 1] for i in range(len(body))]
    with pytest.raises(_UnusableGpuAiResponse, match="MPEG bitstream"):
        run_with_body(monkeypatch, chunks, voice="Roger-el", engine="elevenlabs")


def test_stereo_is_refused_rather_than_reinterpreted(monkeypatch):
    """No correction path exists for channels, so guessing is not an option."""
    body = wav(24000, channels=2, payload=bytes(800))
    with pytest.raises(_UnusableGpuAiResponse, match="2-channel"):
        run_with_body(monkeypatch, [body])


def test_zero_channel_fmt_is_refused_not_divided_by(monkeypatch):
    body = wav(24000, channels=0, payload=bytes(400))
    with pytest.raises(_UnusableGpuAiResponse, match="0-channel"):
        run_with_body(monkeypatch, [body])


def test_prewarm_hook_builds_the_v1_base_url(monkeypatch):
    """The hook is the only thing that fills the cache; its wiring matters."""
    from agent.main_agent import _prewarm

    seen = []
    monkeypatch.setattr(plugins, "_voice_engine_cache", None)
    monkeypatch.setattr(plugins, "prewarm_voice_registry", lambda url: seen.append(url))

    monkeypatch.setattr(settings, "gpu_ai_llm_url", "http://mcp-api-server:8000/")
    _prewarm(None)
    assert seen == ["http://mcp-api-server:8000/v1"]

    seen.clear()
    monkeypatch.setattr(settings, "gpu_ai_llm_url", "")
    _prewarm(None)
    assert seen == [], "an unset gateway url must not be turned into '/v1'"


def test_worker_options_wiring():
    """Every field this function assembles fails quietly, so pin all of them.

    prewarm_fnc: without it the cache is never filled and every sample rate is
    a guess -- sessions still work, so nothing surfaces.
    agent_name: dispatch is explicit, so a wrong name registers a worker that
    simply never receives jobs for its tenant.
    entrypoint_fnc: likewise assembled here and not covered anywhere else.
    """
    from agent.main_agent import _prewarm, build_worker_options, entrypoint

    opts = build_worker_options("agent-x")
    assert opts.prewarm_fnc is _prewarm
    assert opts.entrypoint_fnc is entrypoint
    assert opts.agent_name == "agent-x"


def test_non_16_bit_audio_is_refused(monkeypatch):
    body = wav(24000, bits=32, payload=bytes(400))
    with pytest.raises(_UnusableGpuAiResponse, match="32-bit"):
        run_with_body(monkeypatch, [body])


def test_non_wave_response_is_refused(monkeypatch):
    with pytest.raises(_UnusableGpuAiResponse, match="cannot read"):
        run_with_body(monkeypatch, [b"<html>gateway error</html>" + bytes(100)])


# ── the empty/short responses that used to raise from flush() ───

@pytest.mark.parametrize("body,label", [
    ([], "empty body"),
    ([b"RIFF\xff\xff\xff\xffWA"], "header truncated mid-stream"),
])
def test_no_audio_is_reported_as_no_audio(monkeypatch, caplog, body, label):
    """Deferring initialize() means flush() can be reached un-started.

    The end state is the same either way -- the blanket handler catches the
    RuntimeError flush() would raise -- so the guard is only observable in
    what gets logged, and that is what is asserted. A log saying "AudioEmitter
    isn't started" sends the next reader after a bug in the emitter rather
    than at the gateway that sent nothing.
    """
    _tts, em = run_with_body(monkeypatch, body)
    assert not em.started and em.flushes == 0, label
    messages = [r.getMessage() for r in caplog.records]
    assert any("returned no audio" in m for m in messages), messages
    assert not any("isn't started" in m for m in messages), messages


def test_http_error_returns_without_touching_the_emitter(monkeypatch):
    tts = build_tts(monkeypatch)
    tts._client = FakeClient(FakeResponse([b"nope"], status_code=503))
    em = run_stream(tts, [])
    assert not em.started and em.flushes == 0


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
