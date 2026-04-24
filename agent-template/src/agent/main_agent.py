"""Main LiveKit voice agent — two-brain architecture.

Primary brain (fast LLM): user-facing voice conversation, low latency.
Secondary brain (Letta): deep reasoning, tool execution, memory, crews.

Uses official LiveKit patterns:
- FallbackAdapter for runtime STT/LLM/TTS failover
- MultilingualModel for semantic turn detection
- BackgroundAudioPlayer for ambient/thinking sounds (configurable)
- bithuman.AvatarSession for live avatar (configurable)
- OTEL-based Langfuse tracing via set_tracer_provider (always on)
- CaptureManager for periodic frame → MinIO storage (configurable)
- DocumentReceiver for user file upload → Letta archival (always on)
"""

import asyncio
import base64
import hashlib
import io
import json as _json
import logging
import os
import socket
from dataclasses import dataclass
from uuid import uuid4

import livekit.agents
livekit.agents.DEFAULT_API_CONNECT_OPTIONS = livekit.agents.APIConnectOptions(
    timeout=120.0, max_retry=3, retry_interval=2.0,
)

import httpx
from livekit.agents import (
    Agent, AgentSession, AutoSubscribe, JobContext, WorkerOptions,
    cli, function_tool, metrics, room_io, RunContext,
)
from livekit.agents.voice import ConversationItemAddedEvent, MetricsCollectedEvent
from livekit.plugins import silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

from agent.plugins import (
    create_llm_with_fallback, create_stt_with_fallback, create_tts_with_fallback,
)
from config import settings
from observability import flush_langfuse, init_langfuse

logger = logging.getLogger("main-agent")


def _flashhead_engine_url() -> str:
    """Normalize legacy deployments to the current shared FlashHead service."""
    engine_url = settings.flashhead_engine_url
    if "flashhead-engine.flashhead.svc.cluster.local" in engine_url:
        logger.warning(
            "Legacy FLASHHEAD_ENGINE_URL %s detected; using live-avatar service",
            engine_url,
        )
        return "ws://avatar-service.live-avatar.svc.cluster.local:8080/v1/session"
    return engine_url


async def _prepare_flashhead_reference_image(source: str) -> tuple[str, object | None]:
    """Serve a tight face crop so FlashHead lip motion is visible in clients."""
    if not source.startswith(("http://", "https://")):
        return source, None

    try:
        from aiohttp import web
        from PIL import Image

        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            response = await client.get(source)
            response.raise_for_status()

        image = Image.open(io.BytesIO(response.content)).convert("RGB")
        width, height = image.size
        side = int(min(width, height) * 0.58)
        center_x = int(width * 0.5)
        center_y = int(height * 0.34)
        left = max(0, min(width - side, center_x - side // 2))
        top = max(0, min(height - side, center_y - side // 2))
        crop = image.crop((left, top, left + side, top + side)).resize((512, 512), Image.Resampling.LANCZOS)

        output = io.BytesIO()
        crop.save(output, format="JPEG", quality=92)
        crop_bytes = output.getvalue()

        async def _serve_avatar(_request):
            return web.Response(body=crop_bytes, content_type="image/jpeg")

        app = web.Application()
        app.router.add_get("/flashhead-reference.jpg", _serve_avatar)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "0.0.0.0", 0)
        await site.start()

        sockets = getattr(site, "_server", None).sockets  # type: ignore[union-attr]
        port = sockets[0].getsockname()[1]
        pod_ip = socket.gethostbyname(socket.gethostname())
        crop_url = f"http://{pod_ip}:{port}/flashhead-reference.jpg"
        logger.info(
            "Prepared FlashHead face-crop reference: source_size=%sx%s crop=%s,%s,%s,%s url=%s",
            width,
            height,
            left,
            top,
            left + side,
            top + side,
            crop_url,
        )
        return crop_url, runner
    except Exception:
        logger.exception("FlashHead face-crop preparation failed; using original reference image")
        return source, None


def _instrument_flashhead_avatar(avatar) -> None:
    """Log FlashHead audio/video flow without changing plugin behavior."""
    generator = getattr(avatar, "_generator", None)
    if generator is None:
        return

    original_push_audio = getattr(generator, "push_audio", None)
    if original_push_audio is not None and not getattr(generator, "_bionic_push_logged", False):
        generator._bionic_push_logged = True
        push_counts = {"audio": 0, "segment_end": 0, "bytes": 0}

        async def _logged_push_audio(frame):
            frame_type = type(frame).__name__
            if frame_type == "AudioSegmentEnd":
                push_counts["segment_end"] += 1
                logger.info(
                    "FlashHead bridge sent segment_end: audio_frames=%d audio_bytes=%d",
                    push_counts["audio"],
                    push_counts["bytes"],
                )
            else:
                payload = getattr(frame, "data", b"") or b""
                frame_bytes = len(payload)
                push_counts["audio"] += 1
                push_counts["bytes"] += frame_bytes
                if push_counts["audio"] == 1:
                    logger.info(
                        "FlashHead bridge sent audio frame: count=%d sample_rate=%s "
                        "channels=%s samples=%s bytes=%d",
                        push_counts["audio"],
                        getattr(frame, "sample_rate", None),
                        getattr(frame, "num_channels", None),
                        getattr(frame, "samples_per_channel", None),
                        frame_bytes,
                    )
            return await original_push_audio(frame)

        generator.push_audio = _logged_push_audio

    recv_queue = getattr(generator, "_recv_queue", None)
    original_put = getattr(recv_queue, "put", None)
    if recv_queue is not None and original_put is not None and not getattr(generator, "_bionic_recv_logged", False):
        generator._bionic_recv_logged = True
        recv_counts = {"video": 0, "audio": 0, "segment_end": 0}
        video_hashes: set[str] = set()

        async def _logged_put(item):
            item_type = type(item).__name__ if item is not None else "None"
            if item_type == "VideoFrame":
                recv_counts["video"] += 1
                if recv_counts["video"] <= 20:
                    try:
                        video_hashes.add(hashlib.sha256(bytes(item.data)).hexdigest()[:12])
                    except Exception:
                        pass
                if recv_counts["video"] == 1:
                    logger.info(
                        "FlashHead bridge received video frame: count=%d unique_hashes=%d",
                        recv_counts["video"],
                        len(video_hashes),
                    )
            elif item_type == "AudioFrame":
                recv_counts["audio"] += 1
            elif item_type == "AudioSegmentEnd":
                recv_counts["segment_end"] += 1
                logger.info(
                    "FlashHead bridge received segment_end: video_frames=%d audio_frames=%d "
                    "unique_video_hashes=%d",
                    recv_counts["video"],
                    recv_counts["audio"],
                    len(video_hashes),
                )
            return await original_put(item)

        recv_queue.put = _logged_put


# ── Langfuse via OTEL (always on when keys present) ─────────────

def setup_langfuse_otel(session_id: str):
    """Configure Langfuse tracing via OpenTelemetry for full pipeline visibility.

    This traces LLM calls, STT/TTS latency, and tool execution automatically —
    not just @observe-decorated functions.
    """
    from livekit.agents.telemetry import set_tracer_provider

    public_key = settings.langfuse_public_key
    secret_key = settings.langfuse_secret_key
    host = settings.langfuse_host

    if not public_key or not secret_key or not host:
        logger.info("Langfuse keys not configured — OTEL tracing disabled")
        init_langfuse()  # Fall back to SDK-based tracing
        return None

    try:
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        langfuse_auth = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
        os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = f"{host.rstrip('/')}/api/public/otel"
        os.environ["OTEL_EXPORTER_OTLP_HEADERS"] = f"Authorization=Basic {langfuse_auth}"

        trace_provider = TracerProvider()
        trace_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
        set_tracer_provider(trace_provider, metadata={
            "langfuse.session.id": session_id,
            "app_slug": settings.app_slug,
            "agent_name": settings.agent_name,
        })

        # Auto-instrument httpx so Letta HTTP calls appear in traces
        try:
            from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
            HTTPXClientInstrumentor().instrument()
        except ImportError:
            pass  # Optional — traces still capture LiveKit pipeline

        logger.info("Langfuse OTEL tracing enabled (session=%s)", session_id)
        return trace_provider
    except Exception as e:
        logger.warning("OTEL tracing setup failed (%s), falling back to SDK", e)
        init_langfuse()
        return None


# ── Letta client config ─────────────────────────────────────────

LETTA_BASE = settings.letta_base_url.rstrip("/")
LETTA_TOKEN = settings.letta_api_key or settings.mcp_api_key or ""
LETTA_AGENT_ID = settings.letta_agent_id or ""
LETTA_HEADERS = {
    "Content-Type": "application/json",
    **({"Authorization": f"Bearer {LETTA_TOKEN}"} if LETTA_TOKEN else {}),
}


# ── Delegation contracts ─────────────────────────────────────────

@dataclass
class DelegationRequest:
    """Structured payload sent to Letta for background support work."""

    task: str
    spoken_context_last_60s: str = ""
    correlation_id: str = ""

    def to_framed_message(self) -> str:
        meta = {
            "type": "delegation_request",
            "task_type": "research",
            "output_target": "summary_and_presentation",
            "correlation_id": self.correlation_id,
        }
        if self.spoken_context_last_60s:
            meta["spoken_context_last_60s"] = self.spoken_context_last_60s
        return (
            f"[Delegation metadata]: {_json.dumps(meta)}\n\n"
            "[Assignment from the primary voice agent]\n"
            "Research this in depth, then return two kinds of output:\n"
            "1. Concise categorized bullets for the primary agent to explain aloud.\n"
            "2. Presentation-ready visual/support material. If you generate images or files, "
            "include artifact JSON blocks with type=artifact and image_url/download_url.\n\n"
            f"{self.task}"
        )


# ── Per-user memory isolation ────────────────────────────────────

_swap_lock = asyncio.Lock()


async def swap_user_memory_block(user_id: str) -> None:
    """Swap the Letta agent's 'human' block to one specific to this user.

    Creates a per-user block on first visit, reuses it on subsequent sessions.
    Shared blocks (persona, business, team) stay permanently attached.

    Uses a JSON file in the agent pod as a lightweight registry. In production,
    the platform server manages this via the user_memory_blocks DB table.

    Guarded by _swap_lock to prevent concurrent attach/detach races if
    multiple jobs share the same LETTA_AGENT_ID process.
    """
    if not LETTA_AGENT_ID or not user_id:
        return

    async with _swap_lock:
        import json
        registry_path = f"/tmp/user_blocks_{settings.agent_name}.json"

        # Load registry
        try:
            with open(registry_path) as f:
                registry: dict = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            registry = {}

        async with httpx.AsyncClient(timeout=30.0) as client:
            # Get agent's current blocks
            try:
                resp = await client.get(
                    f"{LETTA_BASE}/v1/agents/{LETTA_AGENT_ID}/",
                    headers=LETTA_HEADERS,
                )
                resp.raise_for_status()
                agent_data = resp.json()
                current_blocks = agent_data.get("memory", {}).get("blocks", [])
            except Exception as e:
                logger.warning("Could not fetch agent blocks: %s", e)
                return

            # Find currently attached human block
            current_human = next((b for b in current_blocks if b.get("label") == "human"), None)
            current_human_id = current_human["id"] if current_human else None

            # Check if this user already has a block
            user_block_id = registry.get(user_id)

            if user_block_id and user_block_id == current_human_id:
                logger.info("User block already active: user=%s block=%s", user_id, user_block_id)
                return

            if not user_block_id:
                # First visit — create a new block for this user
                try:
                    create_resp = await client.post(
                        f"{LETTA_BASE}/v1/blocks/",
                        json={
                            "label": "human",
                            "value": f"User: {user_id}\nPreferences: (none yet)\nContext: (new session)",
                            "limit": 20000,
                        },
                        headers=LETTA_HEADERS,
                    )
                    create_resp.raise_for_status()
                    block_data = create_resp.json()
                    user_block_id = block_data["id"]
                    registry[user_id] = user_block_id
                    logger.info("Created user block: user=%s block=%s", user_id, user_block_id)
                except Exception as e:
                    logger.warning("Failed to create user block: %s", e)
                    return

            # Detach current human block (if different)
            if current_human_id and current_human_id != user_block_id:
                try:
                    await client.patch(
                        f"{LETTA_BASE}/v1/agents/{LETTA_AGENT_ID}/blocks/detach/{current_human_id}/",
                        headers=LETTA_HEADERS,
                    )
                    logger.info("Detached previous human block: %s", current_human_id)
                except Exception as e:
                    logger.warning("Failed to detach block %s: %s", current_human_id, e)

            # Attach this user's block
            try:
                await client.patch(
                    f"{LETTA_BASE}/v1/agents/{LETTA_AGENT_ID}/blocks/attach/{user_block_id}/",
                    headers=LETTA_HEADERS,
                )
                logger.info("Attached user block: user=%s block=%s", user_id, user_block_id)
            except Exception as e:
                logger.warning("Failed to attach user block %s: %s", user_block_id, e)
                return

        # Persist registry
        try:
            with open(registry_path, "w") as f:
                json.dump(registry, f)
        except Exception:
            pass  # Non-fatal — block is already attached


# ── Agent definition ─────────────────────────────────────────────

class MainAgent(Agent):
    """Voice agent with two-brain architecture."""

    def __init__(self) -> None:
        self._recent_turns: list[str] = []
        super().__init__(
            instructions=settings.system_prompt or self._default_prompt(),
            turn_detection=MultilingualModel(),
        )

    async def on_enter(self):
        self.session.generate_reply(
            user_input=(
                "[System: The user has just joined the live session. "
                "Start the conversation now according to your configured persona "
                "and opening instructions. Keep it warm, brief, and spoken-friendly.]"
            )
        )

    @staticmethod
    def _default_prompt() -> str:
        vision_line = ""
        if settings.vision_enabled:
            vision_line = """
VISION:
You can see the user's camera or screen. Describe what you see when asked.
Use visual context to give more relevant, specific answers.
"""
        return f"""You are a voice AI assistant for {settings.app_slug}.
You help users by conversing naturally.
Keep responses concise and conversational (voice-first).
Always finish with terminal punctuation.
Never use markdown, lists, or formatting that cannot be spoken aloud.
{vision_line}
DELEGATION:
When the user asks for research, analysis, complex tasks, or anything requiring
deep reasoning, tools, memory recall, or multi-step workflows, call the
delegate_to_letta tool. The secondary agent handles memory, document search,
web research, and crew execution on your behalf.
Delegation runs in the background. Keep talking naturally while Letta works.
Do not read raw research aloud. When support material appears on screen, explain
the key points in spoken-friendly language and use the visuals as teaching aids.
"""

    @function_tool
    async def delegate_to_letta(self, context: RunContext, task: str) -> str:
        """Delegate a complex task to the secondary agent (Letta) for deep processing.

        Use this for: research, analysis, crew execution, document search,
        memory operations, or any task requiring tools and deep reasoning.

        Args:
            task: A clear description of what needs to be done.

        Returns:
            The result from the secondary agent.
        """
        if not LETTA_AGENT_ID:
            return "Secondary agent not configured. Please set LETTA_AGENT_ID."

        logger.info("Delegating to Letta in background: %s...", task[:100])

        room = None
        session = None
        try:
            room = context.session.room_io.room if context.session.room_io else None
            session = context.session
        except Exception as e:
            logger.debug("Could not capture room/session for delegation: %s", e)

        request = DelegationRequest(
            task=task,
            spoken_context_last_60s="\n".join(self._recent_turns[-5:]),
            correlation_id=uuid4().hex[:12],
        )
        asyncio.create_task(
            _delegation_worker(request, room, session),
            name=f"letta-delegation-{request.correlation_id}",
        )

        return (
            "I am asking the research assistant to prepare the deeper material now. "
            "I will keep explaining while the supporting details and visuals appear on screen."
        )


async def _delegation_worker(
    request: DelegationRequest,
    room,
    session=None,
) -> None:
    """Run Letta work off the voice path and publish split UI channels."""
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=15.0, read=300.0, write=15.0, pool=15.0),
            follow_redirects=True,
        ) as client:
            response = await client.post(
                f"{LETTA_BASE}/v1/agents/{LETTA_AGENT_ID}/messages",
                json={"messages": [{"role": "user", "content": request.to_framed_message()}]},
                headers=LETTA_HEADERS,
            )
            response.raise_for_status()
            result = _parse_letta_response(response.json())

        summary = _filter_letta_noise(result.get("summary", ""))
        presentation = _filter_letta_noise(result.get("presentation", ""))
        combined = _filter_letta_noise(result.get("combined", ""))

        if room:
            if summary:
                await room.local_participant.send_text(summary, topic="lk.chat.summary")
            if presentation:
                await room.local_participant.send_text(presentation, topic="lk.chat.presentation")
            if not summary and not presentation and combined:
                await room.local_participant.send_text(combined, topic="lk.chat.summary")
            logger.info(
                "Letta support published: summary=%d presentation=%d",
                len(summary),
                len(presentation),
            )

        if session and summary:
            session.generate_reply(
                user_input=(
                    "[System: Letta has produced support material for the current discussion. "
                    "Categorized bullets are visible in the side panel and visuals/documents are "
                    "on the presentation screen. Explain the key bullets naturally, use the "
                    "presentation visuals as teaching aids, and avoid reading raw research verbatim.]\n\n"
                    f"{summary[:3500]}"
                ),
                allow_interruptions=True,
            )

    except httpx.TimeoutException:
        logger.error("Letta delegation timed out for task: %s", request.task[:100])
        if room:
            await room.local_participant.send_text(
                "[The research assistant is still working on this. Results may appear shortly.]",
                topic="lk.chat.summary",
            )
    except httpx.HTTPStatusError as e:
        logger.error("Letta delegation HTTP error: %s", e.response.status_code)
        if room:
            await room.local_participant.send_text(
                "[The research assistant encountered an error processing that request.]",
                topic="lk.chat.summary",
            )
    except Exception as e:
        logger.error("Letta delegation failed: %s", e)
        if room:
            await room.local_participant.send_text(
                "[Could not reach the research assistant. Please try again.]",
                topic="lk.chat.summary",
            )


def _filter_letta_noise(text: str) -> str:
    """Remove Letta internal status lines before sending content to the UI."""
    if not text:
        return text
    filtered: list[str] = []
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("*(No output") or stripped.startswith("*(Waiting"):
            continue
        if stripped.startswith("*(") and stripped.endswith(")*"):
            continue
        if stripped == "---":
            continue
        filtered.append(line)
    return "\n".join(filtered).strip()


def _parse_letta_response(data: dict | list) -> dict:
    """Parse Letta API response into summary and presentation channels.

    Known message_type values:
      reasoning_message — internal chain-of-thought (skipped)
      tool_call_message — tool invocation (skipped)
      tool_return_message — tool result (included if substantial)
      assistant_message — spoken output (always included)
    """
    messages = data if isinstance(data, list) else data.get("messages", [])
    if not messages:
        return {
            "summary": "Secondary agent returned no output.",
            "presentation": "",
            "combined": "Secondary agent returned no output.",
        }

    result_parts = []
    artifacts = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue

        msg_type = msg.get("message_type") or msg.get("role") or ""

        if msg_type in ("assistant_message", "assistant"):
            content = msg.get("assistant_message") or msg.get("content") or msg.get("text") or ""
            if content:
                result_parts.append(str(content))

        elif msg_type == "tool_return_message":
            tool_return = msg.get("tool_return") or msg.get("content") or ""
            status = msg.get("status") or ""
            if status == "error":
                result_parts.append(f"[Tool error]: {str(tool_return)[:500]}")
            elif tool_return and len(str(tool_return)) > 20:
                try:
                    parsed = _json.loads(str(tool_return)) if isinstance(tool_return, str) else tool_return
                    if isinstance(parsed, dict):
                        if "summary" in parsed:
                            result_parts.append(str(parsed["summary"]))
                        if isinstance(parsed.get("artifacts"), list):
                            artifacts.extend(parsed["artifacts"])
                        elif any(k in parsed for k in ("url", "download_url", "image_url")):
                            artifacts.append(parsed)
                        if "summary" not in parsed and not artifacts:
                            result_parts.append(f"[Tool result]: {str(tool_return)[:2000]}")
                    else:
                        result_parts.append(f"[Tool result]: {str(tool_return)[:2000]}")
                except (ValueError, TypeError):
                    result_parts.append(f"[Tool result]: {str(tool_return)[:2000]}")

    summary = "\n\n".join(result_parts).strip()
    presentation_parts: list[str] = []
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            continue
        url = artifact.get("image_url") or artifact.get("url") or artifact.get("download_url") or artifact.get("path") or ""
        content_type = artifact.get("content_type") or ""
        subtype = artifact.get("subtype") or ("image" if str(content_type).startswith("image/") else "file")
        presentation_parts.append(
            _json.dumps({
                "type": "artifact",
                "subtype": subtype,
                "title": artifact.get("title") or artifact.get("filename") or "Support material",
                "filename": artifact.get("filename", ""),
                "summary": artifact.get("summary", ""),
                "image_url": url if subtype == "image" else "",
                "download_url": url,
                "url": url,
                "content_type": content_type,
                "internal_s3_url": artifact.get("internal_s3_url", ""),
            })
        )

    if not summary and not presentation_parts:
        summary = "Task delegated. Secondary agent processed but produced no displayable output."

    presentation = "\n\n".join(presentation_parts)
    combined = "\n\n".join(part for part in (summary, presentation) if part)
    return {"summary": summary, "presentation": presentation, "combined": combined}


# ── Capture: periodic frame storage ──────────────────────────────

class CaptureManager:
    """Captures video frames at intervals and uploads to MinIO.

    Configurable via CAPTURE_MODE (off | camera | screen | both).
    This is for storage/analysis, NOT for LLM vision input.
    """

    def __init__(self, room, user_label: str):
        self._room = room
        self._user_label = user_label
        self._running = False
        self._task: asyncio.Task | None = None

    async def start(self):
        if settings.capture_mode == "off":
            return
        self._running = True
        self._task = asyncio.create_task(self._capture_loop())
        logger.info("Capture started: mode=%s, interval=%ss",
                     settings.capture_mode, settings.capture_interval_seconds)

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _capture_loop(self):
        from livekit import rtc

        while self._running:
            await asyncio.sleep(settings.capture_interval_seconds)
            if not self._running:
                break
            try:
                for participant in self._room.remote_participants.values():
                    for pub in participant.track_publications.values():
                        if pub.track and pub.track.kind == rtc.TrackKind.KIND_VIDEO:
                            if not self._should_capture(pub.source):
                                continue
                            await self._capture_frame(pub.track, participant.identity)
                            break
            except Exception as e:
                logger.warning("Capture frame failed: %s", e)

    def _should_capture(self, source) -> bool:
        from livekit import rtc
        mode = settings.capture_mode
        if mode == "both":
            return True
        if mode == "camera" and source == rtc.TrackSource.SOURCE_CAMERA:
            return True
        if mode == "screen" and source == rtc.TrackSource.SOURCE_SCREEN_SHARE:
            return True
        return False

    async def _capture_frame(self, track, participant_identity: str):
        import io
        from datetime import datetime, timezone
        from livekit import rtc

        video_stream = rtc.VideoStream(track, format=rtc.VideoBufferType.RGBA)
        try:
            async for frame_event in video_stream:
                frame = frame_event.frame
                try:
                    from PIL import Image
                    img = Image.frombytes("RGBA", (frame.width, frame.height), bytes(frame.data))
                    buf = io.BytesIO()
                    img.save(buf, format="PNG", optimize=True)
                    png_bytes = buf.getvalue()
                except ImportError:
                    png_bytes = bytes(frame.data)

                timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
                key = f"captures/{settings.agent_name}/{participant_identity}/{timestamp}.png"
                await self._upload_to_minio(key, png_bytes)
                logger.info("Captured frame: %s (%dx%d)", key, frame.width, frame.height)
                break
        finally:
            await video_stream.aclose()

    async def _upload_to_minio(self, key: str, data: bytes):
        if not settings.minio_access_key:
            return
        try:
            import io
            from minio import Minio
            client = Minio(
                settings.minio_endpoint,
                access_key=settings.minio_access_key,
                secret_key=settings.minio_secret_key,
                secure=settings.minio_use_ssl,
            )
            bucket = settings.minio_bucket or settings.app_slug
            client.put_object(bucket, key, io.BytesIO(data), len(data), content_type="image/png")
        except Exception as e:
            logger.warning("MinIO upload failed: %s", e)


# ── Document upload via data channel ─────────────────────────────

class DocumentReceiver:
    """Receives file uploads from chat users via LiveKit byte streams.

    Files are chunked and stored as Letta archival passages so the
    secondary agent can reference them during the session.
    """

    def __init__(self, room, user_label: str):
        self._room = room
        self._user_label = user_label

    async def start(self):
        if not LETTA_AGENT_ID:
            logger.info("Document receiver disabled — no LETTA_AGENT_ID")
            return
        self._room.register_byte_stream_handler("document-upload", self._handle_document)
        logger.info("Document upload receiver started")

    async def _handle_document(self, reader):
        try:
            info = reader.info
            filename = info.name or "uploaded_file"
            logger.info("Receiving document: %s from user=%s", filename, self._user_label)

            chunks = []
            async for chunk in reader:
                chunks.append(chunk)
            file_data = b"".join(chunks)

            if not file_data or len(file_data) > 25 * 1024 * 1024:
                await self._notify("File empty or too large (max 25MB).")
                return

            text = self._extract_text(file_data, filename)
            if not text or len(text.strip()) < 10:
                await self._notify("Could not extract text from that file.")
                return

            text_chunks = self._chunk_text(text)
            stored = 0
            for chunk in text_chunks:
                try:
                    async with httpx.AsyncClient(timeout=30.0) as client:
                        resp = await client.post(
                            f"{LETTA_BASE}/v1/agents/{LETTA_AGENT_ID}/archival/",
                            json={"text": f"[Document: {filename}] [User: {self._user_label}] {chunk}"},
                            headers=LETTA_HEADERS,
                        )
                        if resp.status_code < 300:
                            stored += 1
                except Exception as e:
                    logger.warning("Letta archival store failed: %s", e)

            logger.info("Document indexed: %s → %d/%d chunks", filename, stored, len(text_chunks))
            await self._notify(f"'{filename}' indexed: {stored} passages stored in memory.")

        except Exception as e:
            logger.error("Document processing failed: %s", e)

    def _extract_text(self, data: bytes, filename: str) -> str:
        ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
        if ext in ("txt", "md", "csv"):
            return data.decode("utf-8", errors="replace")
        if ext == "json":
            import json
            try:
                return json.dumps(json.loads(data.decode("utf-8")), indent=2)
            except json.JSONDecodeError:
                return data.decode("utf-8", errors="replace")
        return data.decode("utf-8", errors="replace")

    def _chunk_text(self, text: str, size: int = 1500, overlap: int = 200) -> list[str]:
        chunks, start = [], 0
        while start < len(text):
            chunk = text[start:start + size].strip()
            if chunk:
                chunks.append(chunk)
            start += size - overlap
            if start >= len(text):
                break
        return chunks

    async def _notify(self, message: str):
        try:
            await self._room.local_participant.send_text(message, topic="system-message")
        except Exception:
            pass


# ── Entrypoint ───────────────────────────────────────────────────

async def entrypoint(ctx: JobContext):
    """LiveKit agent entrypoint — two-brain architecture."""
    room_name = ctx.job.room.name if ctx.job and ctx.job.room else "unknown"
    try:
        user_label = ctx.token_claims().identity or room_name
    except Exception:
        user_label = room_name

    # Dispatch metadata can override the default avatar per-session
    # (reference_image, avatar_name, instructions) — see flashhead
    # reference agent. Parsed here so it's available below.
    import json as _json
    dispatch_meta: dict = {}
    if ctx.job and ctx.job.metadata:
        try:
            dispatch_meta = _json.loads(ctx.job.metadata)
        except _json.JSONDecodeError:
            logger.warning("non-JSON job metadata: %s", ctx.job.metadata)

    # ── Langfuse OTEL tracing (always on) ────────────────────
    trace_provider = setup_langfuse_otel(session_id=room_name)

    # ── Build session with FallbackAdapters ──────────────────
    # Avatar sessions use a QueueAudioOutput that can't be paused — if
    # an avatar is active we disable interruptions so VAD-driven false
    # triggers don't break lipsync. This matches the flashhead
    # reference agent.
    session_kwargs = dict(
        stt=create_stt_with_fallback(),
        llm=create_llm_with_fallback(),
        tts=create_tts_with_fallback(),
        vad=silero.VAD.load(),
    )
    if settings.avatar_enabled:
        session_kwargs["allow_interruptions"] = False
    session = AgentSession(**session_kwargs)

    # ── Metrics logging ──────────────────────────────────────
    @session.on("metrics_collected")
    def _on_metrics(ev: MetricsCollectedEvent):
        metrics.log_metrics(ev.metrics)

    primary_agent = MainAgent()

    @session.on("conversation_item_added")
    def _on_conversation_item(ev: ConversationItemAddedEvent):
        try:
            msg = ev.item
            role = getattr(msg, "role", None)
            text = getattr(msg, "text_content", None)
            if not text or not text.strip():
                return
            label = "Primary" if role == "assistant" else "User"
            primary_agent._recent_turns.append(f"[{label}]: {text.strip()[:300]}")
        except Exception as e:
            logger.debug("Could not track conversation turn: %s", e)

    # ── Auto-subscribe mode ──────────────────────────────────
    need_video = (
        settings.vision_enabled
        or settings.capture_mode != "off"
        or settings.avatar_enabled
    )
    auto_sub = AutoSubscribe.SUBSCRIBE_ALL if need_video else AutoSubscribe.AUDIO_ONLY

    await ctx.connect(auto_subscribe=auto_sub)

    # ── Per-user memory isolation ────────────────────────────
    # Swap the Letta agent's "human" block to this user's block
    # so each user gets isolated memory within the shared agent.
    await swap_user_memory_block(user_label)

    # ── Avatar (talking-head) ────────────────────────────────
    # Default: flashhead via in-cluster flashhead-engine (WebSocket).
    # Legacy: bithuman (kept for backward compat).
    # Per-session reference image can be injected via dispatch metadata:
    #   metadata={"reference_image": "https://...", "avatar_name": "Alice"}
    avatar = None
    avatar_reference_runner = None
    if settings.avatar_enabled:
        provider = (settings.avatar_provider or "flashhead").lower()

        if provider == "flashhead":
            original_reference_image = (
                dispatch_meta.get("reference_image")
                or settings.flashhead_reference_image
            )
            reference_image = original_reference_image
            avatar_name = (
                dispatch_meta.get("avatar_name")
                or settings.flashhead_avatar_name
                or "Avatar"
            )
            flashhead_engine_url = _flashhead_engine_url()
            if not flashhead_engine_url:
                logger.warning(
                    "avatar_provider=flashhead but FLASHHEAD_ENGINE_URL not set — avatar disabled"
                )
            elif not reference_image:
                logger.warning(
                    "avatar_provider=flashhead but no reference_image "
                    "(set FLASHHEAD_REFERENCE_IMAGE or pass via dispatch metadata) "
                    "— avatar disabled"
                )
            else:
                try:
                    reference_image, avatar_reference_runner = await _prepare_flashhead_reference_image(
                        reference_image
                    )
                    from livekit.plugins import flashhead
                    try:
                        avatar = flashhead.AvatarSession(
                            api_url=flashhead_engine_url,
                            reference_image=reference_image,
                            avatar_participant_identity=f"{settings.agent_name}-avatar",
                            avatar_participant_name=avatar_name,
                        )
                        await avatar.start(session, room=ctx.room)
                    except Exception:
                        if reference_image != original_reference_image:
                            logger.exception(
                                "FlashHead avatar start failed with face-crop reference; "
                                "retrying original reference image"
                            )
                            if avatar_reference_runner is not None:
                                try:
                                    await avatar_reference_runner.cleanup()
                                except Exception:
                                    logger.exception("avatar crop server cleanup failed")
                                avatar_reference_runner = None
                            avatar = flashhead.AvatarSession(
                                api_url=flashhead_engine_url,
                                reference_image=original_reference_image,
                                avatar_participant_identity=f"{settings.agent_name}-avatar",
                                avatar_participant_name=avatar_name,
                            )
                            await avatar.start(session, room=ctx.room)
                        else:
                            raise
                    logger.info(
                        "FlashHead avatar started: engine=%s name=%s",
                        flashhead_engine_url,
                        avatar_name,
                    )
                    logger.info(
                        "FlashHead avatar attached TTS audio output before session.start: %s",
                        type(session.output.audio).__name__ if session.output.audio else "none",
                    )
                    _instrument_flashhead_avatar(avatar)
                except ImportError:
                    logger.warning(
                        "livekit-plugins-flashhead not installed — avatar disabled. "
                        "Install with: pip install '.[avatar]'"
                    )
                    avatar = None
                except Exception as e:
                    logger.warning("FlashHead avatar start failed: %s", e)
                    avatar = None

        elif provider == "bithuman" and settings.bithuman_api_key:
            try:
                from livekit.plugins import bithuman
                avatar = bithuman.AvatarSession(
                    api_secret=settings.bithuman_api_secret or settings.bithuman_api_key,
                )
                await avatar.start(session, room=ctx.room)
                logger.info("BitHuman avatar started")
            except ImportError:
                logger.warning("livekit-plugins-bithuman not installed — avatar disabled")
                avatar = None
            except Exception as e:
                logger.warning("BitHuman avatar start failed: %s", e)
                avatar = None

        else:
            logger.warning(
                "avatar_enabled but provider=%s is not wired or missing creds — avatar disabled",
                provider,
            )

    # ── Start voice session ──────────────────────────────────
    # Match the avatar plugin examples in livekit-plugins:
    #   1. create AgentSession with TTS
    #   2. await avatar.start(session, room=ctx.room)
    #   3. await session.start(agent=..., room=ctx.room)
    #
    # avatar.start() sets session.output.audio to the plugin output
    # (QueueAudioOutput/DataStreamAudioOutput). Do not configure RoomIO
    # audio output here; LiveKit will detect the existing avatar output and
    # avoid replacing it. Only pass RoomOptions when we actually need video
    # input for vision.
    session_start_kwargs = {
        "agent": primary_agent,
        "room": ctx.room,
    }
    if settings.vision_enabled:
        session_start_kwargs["room_options"] = room_io.RoomOptions(video_input=True)

    await session.start(**session_start_kwargs)
    logger.info(
        "Agent session started: avatar_active=%s audio_output=%s",
        avatar is not None,
        type(session.output.audio).__name__ if session.output.audio else "none",
    )

    if settings.vision_enabled:
        logger.info("Vision enabled — primary LLM receives video frames from user")

    # ── Background audio (configurable) ──────────────────────
    if settings.background_audio_enabled:
        try:
            from livekit.agents import BackgroundAudioPlayer, AudioConfig, BuiltinAudioClip
            bg_audio = BackgroundAudioPlayer(
                thinking_sound=[
                    AudioConfig(BuiltinAudioClip.KEYBOARD_TYPING, volume=0.5),
                ],
            )
            await bg_audio.start(room=ctx.room, agent_session=session)
            logger.info("Background audio enabled (thinking sounds)")
        except Exception as e:
            logger.warning("Background audio failed: %s", e)

    # ── Capture & document upload ────────────────────────────
    capture_mgr = CaptureManager(ctx.room, user_label)
    doc_receiver = DocumentReceiver(ctx.room, user_label)
    await capture_mgr.start()
    await doc_receiver.start()

    # ── Shutdown cleanup ─────────────────────────────────────
    async def _shutdown(_reason: str = ""):
        await capture_mgr.stop()
        if avatar is not None:
            try:
                await avatar.aclose()
            except Exception:
                logger.exception("avatar aclose failed (non-fatal)")
        if avatar_reference_runner is not None:
            try:
                await avatar_reference_runner.cleanup()
            except Exception:
                logger.exception("avatar reference server cleanup failed (non-fatal)")
        if trace_provider and hasattr(trace_provider, 'force_flush'):
            trace_provider.force_flush()
        flush_langfuse()

    ctx.add_shutdown_callback(_shutdown)


if __name__ == "__main__":
    agent_name = settings.agent_name or settings.app_slug + "-agent"
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name=agent_name))
