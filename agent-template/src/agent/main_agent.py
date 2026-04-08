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
import logging
import os

import livekit.agents
livekit.agents.DEFAULT_API_CONNECT_OPTIONS = livekit.agents.APIConnectOptions(
    timeout=120.0, max_retry=3, retry_interval=2.0,
)

import httpx
from livekit.agents import (
    Agent, AgentSession, AutoSubscribe, JobContext, WorkerOptions,
    cli, function_tool, metrics, room_io, RunContext,
)
from livekit.agents.voice import MetricsCollectedEvent, ConversationItemAddedEvent
from livekit.plugins import silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

from agent.plugins import (
    create_llm_with_fallback, create_stt_with_fallback, create_tts_with_fallback,
)
from config import settings
from observability import flush_langfuse, init_langfuse

logger = logging.getLogger("main-agent")

# Bump livekit.agents logger to DEBUG so we can see speech-task scheduling,
# turn-completion handlers, and LLM call entry points. This is verbose but
# critical for diagnosing the "STT fires but LLM never runs" silent failure.
# Override via LIVEKIT_AGENTS_LOG_LEVEL=INFO if it gets too noisy.
_lk_log_level = os.environ.get("LIVEKIT_AGENTS_LOG_LEVEL", "DEBUG")
logging.getLogger("livekit.agents").setLevel(_lk_log_level)
logging.getLogger("livekit").setLevel(_lk_log_level)


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

        # Letta returns 307 redirects on trailing-slash URLs in some
        # versions. follow_redirects=True handles both forms.
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            # Get agent's current blocks
            try:
                resp = await client.get(
                    f"{LETTA_BASE}/v1/agents/{LETTA_AGENT_ID}",
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
        # NOTE: turn_detection is set on the AgentSession, not on the Agent.
        # Setting it here too created a duplicate detector that gated the
        # user-turn-commit path, so STT events fired but no LLM call ever
        # followed (the symptom: STT metrics line, EOU metrics line, then
        # silence — no llm metrics, no tts, no chain logging).
        super().__init__(
            instructions=settings.system_prompt or self._default_prompt(),
        )

    async def on_enter(self):
        # IMPORTANT: do NOT call generate_reply() here. _create_speech_task
        # treats on_enter as a foreground speech task; if its LLM call
        # hangs (and ours has been hanging silently against the gpu-ai
        # endpoint in the streaming preemptive path), every subsequent
        # user_turn_completed task awaits the stuck on_enter via
        #   if old_task is not None: await old_task
        # in agent_activity.py, deadlocking the entire pipeline. Symptom:
        # STT fires, EOU fires, [chain] user committed fires, then
        # complete silence — no LLM, no TTS, no conversation_item_added.
        #
        # Letting the user speak first is fine. Once we have a known-good
        # session say(...) call we can re-add a static greeting via
        # session.say("Hello!") which uses the TTS pipeline directly
        # without requiring an LLM completion.
        logger.info("[chain] MainAgent.on_enter — waiting for user to speak first")

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
While waiting, keep the user engaged with brief conversational responses.
When the result comes back, summarize it in spoken-friendly language.
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

        logger.info("[chain] professor → assistant (explicit assignment): %s",
                    task[:200])

        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(connect=15.0, read=300.0, write=15.0, pool=15.0),
            ) as client:
                # Frame as an explicit assignment so Letta understands this
                # is "the professor has asked you to do X and post the
                # result to the screen" — distinct from the passive
                # [Live transcript ...] forwards that the assistant sees
                # for every spoken turn.
                framed_task = (
                    "[Explicit assignment from the professor — "
                    "do this and post the result to the screen]:\n"
                    + task
                )
                response = await client.post(
                    f"{LETTA_BASE}/v1/agents/{LETTA_AGENT_ID}/messages/",
                    json={"messages": [{"role": "user", "content": framed_task}]},
                    headers=LETTA_HEADERS,
                )
                response.raise_for_status()
                result = _parse_letta_response(response.json())

                # Publish the secondary agent's full structured output to the
                # LiveKit chat data channel (topic 'lk.chat') so it appears in
                # the Playground chat panel as a "slide" / supporting material.
                # The voice agent gets back ONLY a short acknowledgement so it
                # gives a brief spoken intro ("Here's a summary on screen…")
                # rather than reading the full result aloud over TTS.
                published = False
                try:
                    room = context.session.room_io.room if context.session.room_io else None
                    if room and result:
                        await room.local_participant.send_text(
                            result,
                            topic="lk.chat",
                        )
                        published = True
                        logger.info(
                            "[chain] assistant → screen (explicit, %d chars)",
                            len(result),
                        )
                except Exception as e:
                    logger.warning("Failed to publish Letta result to chat: %s", e)

                # IMPORTANT: do NOT return the full Letta text to the voice
                # LLM. Returning long content makes the LLM read it back over
                # TTS, duplicating what's already in chat and dragging the
                # spoken latency. A short acknowledgement is enough — the
                # primary prompt instructs the model to give a one-line
                # verbal cue ("I've put a summary on screen for you").
                if published:
                    return "Posted to chat."
                return result[:280] if result else "Done."

        except httpx.TimeoutException:
            logger.error("Letta delegation timed out")
            return "The secondary agent is still processing. It may take a moment for complex tasks."
        except httpx.HTTPStatusError as e:
            logger.error("Letta delegation HTTP error: %s", e.response.status_code)
            return "Secondary agent encountered an error. Please try again."
        except Exception as e:
            logger.error("Letta delegation failed: %s", e)
            return "Failed to reach secondary agent. Please try again shortly."


async def forward_to_assistant_async(
    role: str,
    text: str,
    room,
) -> None:
    """Stream a turn from the live conversation to the secondary (Letta) agent
    so it can proactively prepare supporting visual material — slides,
    summaries, illustrations, crew results — and publish them straight to the
    LiveKit chat data channel (`lk.chat`) for the user to see.

    This is the "professor + assistant" wiring: the primary voice agent owns
    the spoken channel, the secondary brain owns the visual channel. Both run
    in parallel — the assistant doesn't wait for an explicit `delegate_to_letta`
    tool call. Every user utterance and every primary-agent reply is forwarded
    here, the assistant decides whether to react, and any substantive output
    is pushed to chat as a "slide".

    Notes for callers:
    - Fire-and-forget — never block the primary voice loop on Letta latency.
    - Only "assistant_message" content from Letta is treated as a slide;
      reasoning / tool-call internals are filtered by `_parse_letta_response`.
    - Empty / trivial Letta replies are dropped (no chat noise).
    - The user-side appears under participant identity = the agent worker;
      the chat panel groups them under "Secondary Agent Output".
    """
    if not LETTA_AGENT_ID or not text or not text.strip():
        return
    if not room:
        return
    try:
        # Frame the inbound turn as system context so Letta knows who said
        # what. Letta is configured (via DEFAULT_LETTA_PROMPT in
        # server/agentRouter.ts) to react proactively to "the professor said"
        # and "the user said" lines without waiting for an explicit ask.
        speaker = "Professor" if role == "assistant" else "Student"
        framed = f"[Live transcript — {speaker}]: {text.strip()}"

        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=10.0),
        ) as client:
            response = await client.post(
                f"{LETTA_BASE}/v1/agents/{LETTA_AGENT_ID}/messages/",
                json={"messages": [{"role": "user", "content": framed}]},
                headers=LETTA_HEADERS,
            )
            response.raise_for_status()
            result = _parse_letta_response(response.json())

        if not result or len(result.strip()) < 10:
            # No substantive output — assistant chose not to react.
            logger.info("[chain] assistant chose silence (in=%d, out=%d)",
                        len(text), len(result or ""))
            return

        await room.local_participant.send_text(result, topic="lk.chat")
        logger.info(
            "[chain] assistant → screen (proactive, in=%d, out=%d)",
            len(text), len(result),
        )
    except httpx.TimeoutException:
        logger.warning("Proactive Letta forward timed out (role=%s)", role)
    except Exception as e:
        # Never break the voice loop on a Letta error.
        logger.warning("Proactive Letta forward failed: %s", e)


def _parse_letta_response(data: dict | list) -> str:
    """Parse Letta API response, handling known message_type variants.

    Known message_type values:
      reasoning_message — internal chain-of-thought (skipped)
      tool_call_message — tool invocation (skipped)
      tool_return_message — tool result (included if substantial)
      assistant_message — spoken output (always included)
    """
    messages = data if isinstance(data, list) else data.get("messages", [])
    if not messages:
        return "Secondary agent returned no output."

    result_parts = []
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
                result_parts.append(f"[Tool result]: {str(tool_return)[:2000]}")

    if result_parts:
        return "\n\n".join(result_parts)
    return "Task delegated. Secondary agent processed but produced no text output."


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

    # ── Langfuse OTEL tracing (always on) ────────────────────
    trace_provider = setup_langfuse_otel(session_id=room_name)

    # ── Build session with FallbackAdapters ──────────────────
    # turn_detection lives on the AgentSession (NOT on Agent.__init__).
    # Setting it on both creates a duplicate detector that gates
    # commit_user_turn and the LLM never fires.
    #
    # preemptive_generation=False — the framework's default speculative
    # LLM call (started during STT, committed at EOU) was hanging
    # silently against our gpu-ai LLM endpoint. The DEBUG logs showed
    # 'using preemptive generation, preemptive_lead_time: 0.04s' followed
    # by total silence — no LLM call ever completed. Disabling it forces
    # the conventional path: STT → EOU → generate_reply → LLM.
    session = AgentSession(
        stt=create_stt_with_fallback(),
        llm=create_llm_with_fallback(),
        tts=create_tts_with_fallback(),
        vad=silero.VAD.load(),
        turn_detection=MultilingualModel(),
        preemptive_generation=False,
    )

    # ── Metrics logging ──────────────────────────────────────
    @session.on("metrics_collected")
    def _on_metrics(ev: MetricsCollectedEvent):
        metrics.log_metrics(ev.metrics)

    # ── Pipeline visibility ──────────────────────────────────
    # Log committed user turns so we can tell from logs whether STT events
    # are actually reaching the LLM. If you see "[chain] user committed"
    # but no "LLM metrics" line shortly after, the LLM call is the problem;
    # if you don't see it at all, the turn-commit path is broken.
    @session.on("user_input_transcribed")
    def _on_user_transcribed(ev):
        try:
            if getattr(ev, "is_final", False):
                logger.info("[chain] user committed: %s",
                            (getattr(ev, "transcript", "") or "")[:200])
        except Exception:
            pass

    # ── Strict chain-of-command: Professor → Assistant ───────
    #
    # The architecture is: the primary voice agent is a Professor whose
    # ONLY job is to listen, decide, and speak. The Letta secondary agent
    # is the Assistant — the only entity that does knowledge work and the
    # only entity allowed to publish to the screen (chat data channel).
    #
    # We enforce this by forwarding ONLY the professor's spoken turn to
    # Letta (not the raw user STT). That way:
    #   - Letta reacts to what the professor decided to teach, not raw input
    #   - The chain of command is unambiguous: user → professor → letta → chat
    #   - Letta is never racing the professor on user turns
    #
    # Forwarded as a fire-and-forget background task so the voice loop
    # never blocks on Letta latency.
    @session.on("conversation_item_added")
    def _on_conversation_item(ev: ConversationItemAddedEvent):
        try:
            msg = ev.item
            role = getattr(msg, "role", None)
            text = getattr(msg, "text_content", None)
            if not text or not text.strip():
                return
            if role != "assistant":
                # Ignore user STT and tool messages — only the professor's
                # spoken turn drives the assistant.
                return
            logger.info(
                "[chain] professor spoke → forwarding to assistant (chars=%d)",
                len(text),
            )
            asyncio.create_task(
                forward_to_assistant_async("assistant", text, ctx.room),
                name="letta-forward-professor",
            )
        except Exception as e:
            logger.warning("Failed to schedule proactive forward: %s", e)

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

    # ── Avatar (BitHuman, configurable) ──────────────────────
    if settings.avatar_enabled and settings.bithuman_api_key:
        try:
            from livekit.plugins import bithuman
            avatar = bithuman.AvatarSession(
                api_secret=settings.bithuman_api_secret or settings.bithuman_api_key,
            )
            await avatar.start(session, room=ctx.room)
            logger.info("BitHuman avatar started")
        except ImportError:
            logger.warning("livekit-plugins-bithuman not installed — avatar disabled")
        except Exception as e:
            logger.warning("Avatar start failed: %s", e)

    # ── Room options ─────────────────────────────────────────
    room_opts = room_io.RoomOptions(
        # Vision: feed camera/screen frames to the primary LLM (e.g., Gemma 4 E4B)
        video_input=settings.vision_enabled,
        # If avatar is active, it handles audio output
        audio_output=not settings.avatar_enabled,
    )

    await session.start(
        agent=MainAgent(),
        room=ctx.room,
        room_options=room_opts,
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
        if trace_provider and hasattr(trace_provider, 'force_flush'):
            trace_provider.force_flush()
        flush_langfuse()

    ctx.add_shutdown_callback(_shutdown)


if __name__ == "__main__":
    agent_name = settings.agent_name or settings.app_slug + "-agent"
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name=agent_name))
