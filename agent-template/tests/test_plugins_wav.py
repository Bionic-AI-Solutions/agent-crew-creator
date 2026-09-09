"""Regression tests for the gpu-ai TTS WAV header parser.

Written after the streaming path was found to be declaring 22050 Hz for
streams that are actually 24000 Hz (154 of the gateway's 191 voices) and
hardcoding a 44-byte header for a kokoro stream whose data chunk starts at
byte 78. Both shipped as audible defects: 8.84% pitch-shifted audio with
dropouts, and a burst of noise at the head of every kokoro utterance.

The headers below are verbatim captures from the live gateway on 2026-09-09,
so a change in any engine's output shape fails here rather than in someone's
ears.

Run: python3 -m pytest agent-template/tests/test_plugins_wav.py
"""
import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest
from agent import plugins
from agent.plugins import (
    _ENGINE_SAMPLE_RATES,
    _parse_wav_header,
    _sample_rate_from_voice_name,
)

# engine -> (voice captured from, first 128 bytes of its response)
REAL_HEADERS = {
    "omnivoice": ("Eric-ov", bytes.fromhex(
        "52494646ffffffff57415645666d74201000000001000100c05d000080bb0000"
        "0200100064617461ffffffff0000000000000000000000000000000000000000"
        "0000000000000000000000000000000000000000000000000000000000000000"
        "0000000000000000000000000000000000000000000000000000000000000000")),
    "kokoro": ("af_alloy", bytes.fromhex(
        "52494646ffffffff57415645666d74201000000001000100c05d000080bb0000"
        "020010004c4953541a000000494e464f495346540d0000004c61766636322e33"
        "2e313030000064617461ffffffff000000000000000000000000000000000000"
        "0000000000000000000000000000010001000000010000000100000000000000")),
    "openai": ("Alloy", bytes.fromhex(
        "52494646ffffffff57415645666d74201000000001000100c05d000080bb0000"
        "0200100064617461d3ffffff2a0028002b002c002f0037003f003c0037002f00"
        "1d0011000100fbfff5fff5ff00000f002b003b00550057003c001d00ffffe7ff"
        "d4ffcdffbbffc2ffe6ff1a0059009e00d800f8000201e900b60078002800daff")),
    "sarvam": ("Aditya-svm", bytes.fromhex(
        "52494646d8a1000057415645666d742010000000010001002256000044ac0000"
        "0200100064617461b4a100000100010000000100000001000100000001000000"
        "0000ffff0000ffffffff0000ffff0000ffffffff0000fffffefffeffffff0000"
        "ffffffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff")),
}

EXPECTED = {
    # engine: (sample_rate, channels, bits, data_offset)
    "omnivoice": (24000, 1, 16, 44),
    "kokoro": (24000, 1, 16, 78),
    "openai": (24000, 1, 16, 44),
    "sarvam": (22050, 1, 16, 44),
}


@pytest.mark.parametrize("engine", sorted(REAL_HEADERS))
def test_real_engine_headers(engine):
    _voice, raw = REAL_HEADERS[engine]
    assert tuple(_parse_wav_header(raw)) == EXPECTED[engine]


def test_kokoro_data_is_not_at_44():
    """The bug this parser replaces: ffmpeg's LIST/INFO chunk moves `data`."""
    _voice, raw = REAL_HEADERS["kokoro"]
    assert _parse_wav_header(raw).data_offset == 78
    # The 34 bytes the old hardcoded 44 pushed into the audio as 17 samples:
    # the tail of ffmpeg's LIST/INFO chunk plus the whole `data` chunk header.
    assert raw[44:78] == b"INFOISFT\r\x00\x00\x00Lavf62.3.100\x00\x00data\xff\xff\xff\xff"


@pytest.mark.parametrize("engine", sorted(REAL_HEADERS))
def test_every_short_prefix_asks_for_more_rather_than_guessing(engine):
    """A chunk boundary mid-header must never yield a wrong answer."""
    _voice, raw = REAL_HEADERS[engine]
    offset = EXPECTED[engine][3]
    for n in range(offset):
        assert _parse_wav_header(raw[:n]) is None, f"{engine} guessed at {n} bytes"
    assert _parse_wav_header(raw[:offset]) is not None


def test_odd_sized_chunk_is_word_aligned():
    """RIFF pads odd chunks to an even boundary; the walk must skip the pad.

    No engine emits an odd intermediate chunk today -- kokoro's LIST/INFO is
    26 bytes -- so nothing else in this file covers the `+ (chunk_size & 1)`
    term, and dropping it passed the whole suite. A single character's
    difference in a future ffmpeg build string is all it would take.
    """
    fmt = struct.pack("<HHIIHH", 1, 1, 24000, 48000, 2, 16)
    odd = b"LIST" + struct.pack("<I", 15) + b"INFOISFTLavf62" + b"\x00"
    raw = (b"RIFF" + b"\xff" * 4 + b"WAVE"
           + b"fmt " + struct.pack("<I", 16) + fmt
           + odd + b"\x00"                      # the pad byte
           + b"data" + b"\xff" * 4 + b"PCMPCMPC")
    parsed = _parse_wav_header(raw)
    assert parsed.sample_rate == 24000
    assert raw[parsed.data_offset:] == b"PCMPCMPC"


def test_not_a_riff_stream_raises():
    with pytest.raises(ValueError, match="not a RIFF/WAVE"):
        _parse_wav_header(b"ID3\x04\x00\x00\x00\x00\x00#TSSE")


def test_data_before_fmt_raises():
    raw = b"RIFF" + b"\xff" * 4 + b"WAVE" + b"data" + b"\xff" * 4
    with pytest.raises(ValueError, match="data chunk before its fmt"):
        _parse_wav_header(raw)


def test_unbounded_non_data_chunk_raises():
    """0xFFFFFFFF is only meaningful on the chunk still being written."""
    raw = b"RIFF" + b"\xff" * 4 + b"WAVE" + b"LIST" + b"\xff\xff\xff\xff"
    with pytest.raises(ValueError, match="unbounded"):
        _parse_wav_header(raw)


def test_header_search_is_bounded():
    """A stream of plausible chunks must not be walked forever."""
    raw = bytearray(b"RIFF" + b"\xff" * 4 + b"WAVE")
    for _ in range(40):
        raw += b"JUNK" + (200).to_bytes(4, "little") + bytes(200)
    with pytest.raises(ValueError, match="no data chunk"):
        _parse_wav_header(bytes(raw))


# Read from each engine's own `fmt ` chunk against the live gateway on
# 2026-09-09, by POSTing to /v1/audio/speech and parsing the response header.
# This is the ground truth _ENGINE_SAMPLE_RATES is supposed to encode; if the
# two disagree, one of them is what makes the audio crackle.
MEASURED_ENGINE_RATES = {
    "omnivoice": 24000,
    "kokoro": 24000,
    "openai": 24000,
    "elevenlabs": 24000,
    "sarvam": 22050,
}

# Engines the gateway does not serve, inherited from the voice-name heuristic
# this table replaced. Listed so the coverage assertion below stays honest
# about which numbers rest on measurement and which do not.
UNVERIFIED_ENGINE_RATES = {
    "indextts2": 22050,
    "f5": 24000,
    "parler": 24000,
}


@pytest.mark.parametrize("engine,rate", sorted(MEASURED_ENGINE_RATES.items()))
def test_table_matches_what_the_gateway_actually_streams(engine, rate):
    """Every measured engine's rate, pinned to the measurement.

    Not a restatement of the table: mutating any one of these entries used to
    pass the entire suite, because only three engines were reachable through
    a stream test. A wrong entry here reproduces the original defect -- audio
    stretched by the ratio of the two rates -- for that engine alone.
    """
    assert _ENGINE_SAMPLE_RATES[engine] == rate


def test_every_engine_in_the_table_is_accounted_for():
    """A new engine must arrive with a measured rate, not a guess."""
    documented = set(MEASURED_ENGINE_RATES) | set(UNVERIFIED_ENGINE_RATES)
    assert set(_ENGINE_SAMPLE_RATES) == documented, (
        "add the engine to MEASURED_ENGINE_RATES (after reading its `fmt ` "
        "chunk off the gateway) or to UNVERIFIED_ENGINE_RATES"
    )
    for engine, rate in UNVERIFIED_ENGINE_RATES.items():
        assert _ENGINE_SAMPLE_RATES[engine] == rate


def test_unknown_engine_from_the_registry_falls_back_and_says_so(monkeypatch, caplog):
    """The gateway naming an engine the table has never heard of.

    This is what the next roster change looks like -- omnivoice and kokoro
    both arrived this way. The declared rate is what makes audio stretch, so
    the value this branch returns matters as much as any table entry, and
    mutating it to 8000 passed the entire suite before this test existed.
    """
    monkeypatch.setattr(plugins, "_voice_engine_cache", {"newvoice": "some-new-engine"})
    rate = plugins._engine_sample_rate_for_voice("newvoice", "http://gateway/v1")
    assert rate == plugins._DEFAULT_SAMPLE_RATE == 24000
    assert any("no known sample rate" in r.getMessage() for r in caplog.records), (
        "a silent fallback here is how a wrong rate ships unnoticed"
    )


def test_name_fallback_keeps_sarvam_at_its_own_rate():
    """Sarvam is the one engine that is not 24000; the fallback must know."""
    assert _sample_rate_from_voice_name("Aditya-svm") == 22050
    assert _sample_rate_from_voice_name("Sudhir-IndexTTS2") == 22050
    assert _sample_rate_from_voice_name("Shardul") == 24000
    assert _sample_rate_from_voice_name("") == 24000


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
