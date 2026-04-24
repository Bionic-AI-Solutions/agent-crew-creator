"""TTS adapter for the gpu-ai gateway's /audio/speech endpoint.

The gateway exposes IndexTTS-2, F5-TTS and Indic Parler-TTS as
OpenAI-compatible models but returns raw audio (WAV/MP3) rather than
OpenAI's SSE event stream. livekit-plugins-openai.TTS takes the SSE
path for any model not in {"tts-1", "tts-1-hd"} and fails on "no audio
frames were pushed" because the response isn't SSE.

This adapter does a plain POST to /audio/speech and hands the returned
audio bytes to AudioEmitter. Same pattern as the reference impl in
livekit-plugins/flashhead/examples/tools/local_tts.py.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import aiohttp
from livekit.agents import (
    APIConnectionError,
    APIConnectOptions,
    APIStatusError,
    APITimeoutError,
    tts,
    utils,
)
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS


@dataclass
class _GpuAiTTSOpts:
    base_url: str
    api_key: str
    model: str
    voice: str
    response_format: str
    sample_rate: int


async def warmup_tts(
    *,
    base_url: str,
    api_key: str,
    model: str,
    voice: str,
    timeout: float = 20.0,
) -> None:
    """Fire a throwaway synthesis so the cluster loads the TTS model
    before the agent greets. IndexTTS-2's first request after an idle
    period is ~3-6s; subsequent requests are fast. Errors are swallowed.
    """
    base_url = (base_url or "").rstrip("/")
    if not (base_url and api_key):
        return
    try:
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=timeout)
        ) as sess:
            async with sess.post(
                f"{base_url}/audio/speech",
                json={
                    "model": model,
                    "voice": voice,
                    "input": ".",
                    "response_format": "wav",
                },
                headers={
                    "X-API-Key": api_key,
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
            ) as resp:
                await resp.read()
    except Exception:
        pass


class GpuAiTTS(tts.TTS):
    """IndexTTS-2 (and siblings) via the gpu-ai OpenAI-compatible endpoint."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str = "indextts2",
        voice: str = "aditya",
        response_format: str = "wav",
        sample_rate: int = 22050,
        http_session: aiohttp.ClientSession | None = None,
    ) -> None:
        opts = _GpuAiTTSOpts(
            base_url=base_url.rstrip("/"),
            api_key=api_key,
            model=model,
            voice=voice,
            response_format=response_format,
            sample_rate=sample_rate,
        )

        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=opts.sample_rate,
            num_channels=1,
        )
        self._opts = opts
        self._session = http_session

    def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None:
            self._session = utils.http_context.http_session()
        return self._session

    def synthesize(
        self,
        text: str,
        *,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> tts.ChunkedStream:
        return _GpuAiStream(tts=self, input_text=text, conn_options=conn_options)


class _GpuAiStream(tts.ChunkedStream):
    def __init__(
        self,
        *,
        tts: GpuAiTTS,
        input_text: str,
        conn_options: APIConnectOptions,
    ) -> None:
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._tts: GpuAiTTS = tts

    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        opts = self._tts._opts
        request_id = utils.shortuuid()
        url = f"{opts.base_url}/audio/speech"
        payload = {
            "model": opts.model,
            "voice": opts.voice,
            "input": self._input_text,
            "response_format": opts.response_format,
        }
        headers = {
            "X-API-Key": opts.api_key,
            "Authorization": f"Bearer {opts.api_key}",
            "Content-Type": "application/json",
        }

        try:
            async with self._tts._ensure_session().post(
                url,
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(
                    total=60, sock_connect=self._conn_options.timeout
                ),
            ) as resp:
                if not resp.ok:
                    body = await resp.text()
                    raise APIStatusError(
                        f"gpu-ai TTS error: {body}",
                        status_code=resp.status,
                        request_id=request_id,
                        body=body,
                    )
                body_bytes = await resp.read()
        except TimeoutError as e:
            raise APITimeoutError() from e
        except aiohttp.ClientError as e:
            raise APIConnectionError() from e

        if not body_bytes:
            raise APIConnectionError("gpu-ai TTS returned empty body")

        output_emitter.initialize(
            request_id=request_id,
            sample_rate=opts.sample_rate,
            num_channels=1,
            mime_type=f"audio/{opts.response_format}",
        )
        output_emitter.push(body_bytes)
        output_emitter.flush()
