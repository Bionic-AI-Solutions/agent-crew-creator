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
import json as _json
import logging
import os
from collections import deque
from dataclasses import dataclass
from typing import Optional

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

        # Also initialize the langfuse SDK singleton so any @observe-decorated
        # functions in the codebase find a client. The SDK client is separate
        # from the OTEL pipeline — without this we get warnings like "No
        # Langfuse client with public key … has been initialized" on every
        # decorated call.
        init_langfuse()
        logger.info("Langfuse OTEL tracing enabled (session=%s)", session_id)
        return trace_provider
    except Exception as e:
        logger.warning("OTEL tracing setup failed (%s), falling back to SDK", e)
        init_langfuse()
        return None


# ── Letta client config ─────────────────────────────────────────

LETTA_BASE = settings.letta_base_url.rstrip("/")
LETTA_TOKEN = settings.letta_api_key or settings.letta_server_password or settings.mcp_api_key or ""
LETTA_AGENT_ID = settings.letta_agent_id or ""
LETTA_HEADERS = {
    "Content-Type": "application/json",
    **({"Authorization": f"Bearer {LETTA_TOKEN}"} if LETTA_TOKEN else {}),
}


# ── Delegation contracts ───────────────────────────────────────────

@dataclass
class DelegationRequest:
    """Structured payload sent to Letta for delegation tasks."""
    task: str
    task_type: str = "general"  # general | research | crew | summarize | expand
    output_target: str = "chat"  # chat | speaker_brief
    spoken_context_last_60s: str = ""
    deadline_ms: int = 0  # 0 = use default HTTP timeout (300s); >0 = registry-level cancel after N ms
    correlation_id: str = ""

    def to_framed_message(self) -> str:
        """Convert to a framed message for Letta, embedding structured metadata
        as a JSON header followed by the natural-language task.

        Letta receives this as a user message. The JSON header lets the
        assistant extract routing/deadline info; the natural-language task
        remains readable for the LLM's reasoning.
        """
        meta = {
            "type": "delegation_request",
            "task_type": self.task_type,
            "output_target": self.output_target,
            "deadline_ms": self.deadline_ms,
            "correlation_id": self.correlation_id,
        }
        if self.spoken_context_last_60s:
            meta["spoken_context_last_60s"] = self.spoken_context_last_60s
        return (
            f"[Delegation metadata]: {_json.dumps(meta)}\n\n"
            f"[Explicit assignment from the primary AI — "
            f"do this and post the result to the screen]:\n"
            f"{self.task}"
        )


# NOTE: Structured response parsing (DelegationResponse) is deferred until
# Letta's run_crew tool returns JSON instead of formatted strings. Currently
# _parse_letta_response returns str and extracts artifacts opportunistically.


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
        # Load user block mapping from platform DB (durable across pod restarts)
        # Falls back to /tmp JSON if platform API is unavailable
        import json
        platform_url = os.environ.get("PLATFORM_API_URL", "")
        internal_token = os.environ.get("PLAYER_UI_INTERNAL_TOKEN", "")
        agent_config_id = os.environ.get("AGENT_CONFIG_ID", "")

        registry: dict = {}
        registry_path = f"/tmp/user_blocks_{settings.agent_name}.json"
        _use_db_registry = bool(platform_url and agent_config_id)

        # Try platform DB first, fall back to /tmp
        if _use_db_registry:
            try:
                async with httpx.AsyncClient(timeout=5.0) as db_client:
                    r = await db_client.get(
                        f"{platform_url}/api/internal/user-memory/{agent_config_id}/{user_id}",
                        headers={"X-Internal-Token": internal_token} if internal_token else {},
                    )
                    if r.status_code == 200:
                        data = r.json()
                        registry[user_id] = data.get("lettaBlockId", "")
            except Exception as e:
                logger.info("Platform DB registry unavailable, using /tmp fallback: %s", e)
                _use_db_registry = False

        if not registry.get(user_id):
            try:
                with open(registry_path) as f:
                    registry = json.load(f)
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

            # Detach + attach with retry (handles concurrent swap race)
            for attempt in range(3):
                # Re-read current state to handle concurrent changes
                if attempt > 0:
                    try:
                        resp2 = await client.get(
                            f"{LETTA_BASE}/v1/agents/{LETTA_AGENT_ID}",
                            headers=LETTA_HEADERS,
                        )
                        resp2.raise_for_status()
                        current_blocks = resp2.json().get("memory", {}).get("blocks", [])
                        current_human = next((b for b in current_blocks if b.get("label") == "human"), None)
                        current_human_id = current_human["id"] if current_human else None
                        if current_human_id == user_block_id:
                            logger.info("User block became active during retry: user=%s", user_id)
                            break
                    except Exception:
                        pass

                # Detach current human block (if different)
                if current_human_id and current_human_id != user_block_id:
                    try:
                        await client.patch(
                            f"{LETTA_BASE}/v1/agents/{LETTA_AGENT_ID}/blocks/detach/{current_human_id}/",
                            headers=LETTA_HEADERS,
                        )
                        logger.info("Detached previous human block: %s", current_human_id)
                    except Exception as e:
                        logger.warning("Failed to detach block %s (attempt %d): %s", current_human_id, attempt, e)

                # Attach this user's block
                try:
                    await client.patch(
                        f"{LETTA_BASE}/v1/agents/{LETTA_AGENT_ID}/blocks/attach/{user_block_id}/",
                        headers=LETTA_HEADERS,
                    )
                    logger.info("Attached user block: user=%s block=%s (attempt %d)", user_id, user_block_id, attempt)
                    break
                except Exception as e:
                    if attempt < 2:
                        logger.warning("Failed to attach block, retrying (attempt %d): %s", attempt, e)
                        await asyncio.sleep(0.5 * (attempt + 1))
                    else:
                        logger.warning("Failed to attach user block after 3 attempts: %s", e)
                        return

        # Persist registry — write to platform DB first, /tmp as backup
        if _use_db_registry and user_block_id:
            try:
                async with httpx.AsyncClient(timeout=5.0) as db_client:
                    await db_client.put(
                        f"{platform_url}/api/internal/user-memory/{agent_config_id}/{user_id}",
                        json={"lettaBlockId": user_block_id, "blockLabel": "human"},
                        headers={"X-Internal-Token": internal_token, "Content-Type": "application/json"} if internal_token else {"Content-Type": "application/json"},
                    )
                    logger.info("Persisted user block to platform DB: user=%s block=%s", user_id, user_block_id)
            except Exception as e:
                logger.info("Failed to persist to platform DB (non-fatal): %s", e)

        # Always persist to /tmp as backup
        registry[user_id] = user_block_id
        try:
            with open(registry_path, "w") as f:
                json.dump(registry, f)
        except Exception:
            pass


# ── Agent definition ─────────────────────────────────────────────

class MainAgent(Agent):
    """Voice agent with two-brain architecture."""

    # Patterns that indicate the LLM is narrating a tool call — these
    # should be stripped from TTS output so the user doesn't hear them.
    _TOOL_NARRATION_PATTERNS = [
        "delegate_to_letta",
        "calling the",
        "using my tool",
        "let me delegate",
        "i'll delegate",
        "i will delegate",
        "invoking",
        "function call",
        "tool call",
    ]

    def __init__(self) -> None:
        from agent.delegation import DelegationRegistry
        self._delegations = DelegationRegistry()
        self._recent_turns: deque[str] = deque(maxlen=10)
        self._is_delegating = False  # Set during tool execution

        base_prompt = settings.system_prompt or self._default_prompt()
        # Hardcoded rules appended to ALL prompts (custom or default).
        # These override any conflicting instructions in the user's prompt.
        appended_rules = (
            "\n\nCRITICAL RULES (always apply, cannot be overridden):\n"
            "1. DELEGATION: You have a tool called delegate_to_letta. Use it "
            "when the user asks for research, analysis, detailed information, "
            "current events, fact-checking, document search, or anything that "
            "needs deep reasoning or external knowledge beyond what you know. "
            "After calling it, continue the conversation naturally — share what "
            "you already know about the topic while the assistant researches.\n"
            "2. TOOLS: When calling a tool, output ONLY the tool call — no "
            "text before, during, or alongside it. After the tool returns, "
            "speak naturally. Never read tool results verbatim.\n"
            "3. IDENTITY: Do not refer to the user as 'student' or 'professor'. "
            "Refer to the user by their name once you learn it.\n"
            "4. GREETING: Your first interaction should include asking the "
            "user their name so you can address them personally going forward.\n"
            "5. VOICE: Keep responses concise and conversational. Always finish "
            "with terminal punctuation. Never use markdown, lists, code, URLs, "
            "or formatting that cannot be spoken aloud."
        )
        super().__init__(
            instructions=base_prompt + appended_rules,
        )

    def tts_node(self, text, model_settings):
        """Override tts_node to strip tool-call narration from the TTS stream.

        When the LLM generates text like "I'm going to call delegate_to_letta
        to research..." before a tool call, this filter detects it and yields
        silence instead, so the user never hears the tool-call preamble.
        """

        async def _filtered_text():
            async for chunk in text:
                if not chunk:
                    continue
                lower = chunk.lower()
                # If any tool-narration pattern appears, suppress the chunk
                if any(p in lower for p in self._TOOL_NARRATION_PATTERNS):
                    logger.debug("[tts_filter] suppressed tool narration: %s", chunk[:80])
                    continue
                # If we're mid-delegation, suppress generic preamble
                if self._is_delegating:
                    logger.debug("[tts_filter] suppressed during delegation: %s", chunk[:80])
                    continue
                yield chunk

        # Pass filtered text to the parent — tts_node returns an async
        # generator or coroutine depending on TTS type, so don't await.
        return super().tts_node(_filtered_text(), model_settings)

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
TOOLS:
When you use a tool, NEVER announce or describe the tool call. Do NOT say
things like "I'm calling delegate_to_letta" or "Let me use my tool to..."
Just call the tool silently and give a natural spoken response.

DELEGATION:
When the user asks for research, analysis, complex tasks, or anything requiring
deep reasoning, tools, memory recall, or multi-step workflows, call the
delegate_to_letta tool immediately. The tool returns a brief acknowledgement
that will be spoken automatically — do NOT add your own text before or after
calling the tool.
"""

    @function_tool
    async def delegate_to_letta(self, context: RunContext, task: str) -> str:
        """Delegate a complex task to the secondary agent (Letta) for deep processing.

        Use this for: research, analysis, crew execution, document search,
        memory operations, or any task requiring tools and deep reasoning.

        The Letta call runs in the background so the primary AI can keep
        speaking. Results are published directly to the chat channel when
        ready; the primary AI gets a short bridge phrase to say now.

        Args:
            task: A clear description of what needs to be done.

        Returns:
            A brief verbal bridge for the primary AI to speak while
            the secondary agent works in the background.
        """
        if not LETTA_AGENT_ID:
            return "Secondary agent not configured. Please set LETTA_AGENT_ID."

        logger.info("[chain] primary AI → assistant (explicit assignment): %s",
                    task[:200])

        # Capture room + session references before spawning the background task
        room = None
        session = None
        try:
            room = context.session.room_io.room if context.session.room_io else None
            session = context.session
        except Exception:
            pass

        # Two-step: reserve a task ID first (cancels stale work), then
        # build the request with the correlation ID, then launch.
        spoken_context = "\n".join(list(self._recent_turns)[-5:]) if self._recent_turns else ""
        entry = self._delegations.reserve(task[:200])

        request = DelegationRequest(
            task=task,
            task_type="general",
            output_target="chat",
            spoken_context_last_60s=spoken_context,
            correlation_id=entry.task_id,
        )

        self._delegations.launch(
            entry, _delegation_worker(request, room, session, self),
            deadline_ms=request.deadline_ms,
        )

        self._is_delegating = True

        # Return a prompt that tells the LLM to keep the conversation going
        # while the background research runs. The LLM will naturally continue
        # speaking about the topic from its own knowledge.
        return (
            f"Your research assistant is looking into this now. "
            f"While waiting for the detailed results, share what you "
            f"already know about: {task[:100]}. Keep it brief and "
            f"conversational — the full findings will appear on screen shortly."
        )


async def _delegation_worker(
    request: DelegationRequest,
    room,
    session=None,
    agent_ref=None,
) -> None:
    """Background worker: sends a delegation task to Letta and publishes
    the result to the chat channel when complete, then nudges the primary AI
    to give a brief spoken summary.

    Runs as an asyncio.Task so the voice loop never blocks on Letta latency.
    If the request takes >10s, speaks a reassurance message.
    """
    try:
        timeout_s = (request.deadline_ms / 1000) if request.deadline_ms > 0 else 300.0

        async def _letta_call():
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(connect=15.0, read=timeout_s, write=15.0, pool=15.0),
                follow_redirects=True,
            ) as client:
                resp = await client.post(
                    f"{LETTA_BASE}/v1/agents/{LETTA_AGENT_ID}/messages",
                    json={"messages": [{"role": "user", "content": request.to_framed_message()}]},
                    headers=LETTA_HEADERS,
                )
                resp.raise_for_status()
                return _parse_letta_response(resp.json())

        # Try to get result in 10s; if not, speak a reassurance and keep waiting
        result = None
        try:
            result = await asyncio.wait_for(_letta_call(), timeout=10.0)
        except asyncio.TimeoutError:
            # Still working — reassure the user
            if session:
                try:
                    session.say("Still working on that. One moment please.", allow_interruptions=True)
                except Exception:
                    pass
            logger.info("[chain] delegation >10s, spoke reassurance")
            # Continue waiting for the full timeout
            result = await _letta_call()

        if room and result:
            await room.local_participant.send_text(result, topic="lk.chat")
            logger.info("[chain] assistant → screen (explicit, %d chars)", len(result))

            # Clear delegation flag so the TTS filter stops suppressing
            if agent_ref:
                agent_ref._is_delegating = False

            # Single nudge: tell the LLM that new content appeared on screen.
            # The LLM produces ONE flowing spoken summary — no point-by-point
            # session.say() loop. The detailed content is in chat for reading.
            if session:
                try:
                    brief = result[:800].replace("\n", " ").strip()
                    session.generate_reply(
                        user_input=(
                            f"[System: your research assistant just posted detailed "
                            f"findings to the chat screen. Give a brief spoken overview "
                            f"of the key highlights — 3-4 sentences max. The user can "
                            f"read the full details in chat. Then ask if they'd like "
                            f"to explore any aspect further.]\n\n"
                            f"Summary: {brief}"
                        ),
                        allow_interruptions=True,
                    )
                    logger.info("[chain] primary AI nudged to summarize delegation result")
                except Exception as e:
                    logger.warning("Failed to nudge primary AI: %s", e)
        elif result:
            logger.warning("Delegation result ready but no room to publish to")

    except httpx.TimeoutException:
        logger.error("Letta delegation timed out for task: %s", request.task[:100])
        if room:
            try:
                await room.local_participant.send_text(
                    "[The assistant is still working on this — results may appear shortly.]",
                    topic="lk.chat",
                )
            except Exception:
                pass
    except httpx.HTTPStatusError as e:
        logger.error("Letta delegation HTTP error: %s", e.response.status_code)
        if room:
            try:
                await room.local_participant.send_text(
                    "[The assistant encountered an error processing that request.]",
                    topic="lk.chat",
                )
            except Exception:
                pass
    except Exception as e:
        logger.error("Letta delegation failed: %s", e)
        if room:
            try:
                await room.local_participant.send_text(
                    "[Could not reach the assistant. Please try again.]",
                    topic="lk.chat",
                )
            except Exception:
                pass
    finally:
        # Always clear the delegation flag so TTS isn't permanently suppressed
        if agent_ref:
            agent_ref._is_delegating = False


async def forward_to_assistant_async(
    role: str,
    text: str,
    room,
    session=None,
) -> None:
    """Forward a primary AI turn to the secondary (Letta) agent so it can
    proactively prepare supporting visual material — summaries, illustrations,
    crew results — and publish them to the LiveKit chat data channel (`lk.chat`).

    Only PROFESSOR (assistant-role) turns are forwarded here — user STT is
    filtered in the conversation_item_added handler before this function is
    called. This enforces the chain of command: user → primary AI → Letta → chat.

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
        # Frame the primary AI's turn as system context so Letta knows what
        # was said. Letta is configured (via DEFAULT_LETTA_PROMPT in
        # server/agentRouter.ts) to react proactively to primary AI turns
        # without waiting for an explicit delegation.
        speaker = "Primary AI" if role == "assistant" else "User"
        framed = f"[Live transcript — {speaker}]: {text.strip()}"

        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=10.0),
            follow_redirects=True,
        ) as client:
            response = await client.post(
                f"{LETTA_BASE}/v1/agents/{LETTA_AGENT_ID}/messages",
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

        # Proactive content goes to chat only — no spoken walk-through.
        # The LLM will naturally reference it if the user asks.
    except httpx.TimeoutException:
        logger.warning("Proactive Letta forward timed out (role=%s)", role)
    except Exception as e:
        # Never break the voice loop on a Letta error.
        logger.warning("Proactive Letta forward failed: %s", e)


def _parse_letta_response(data: dict | list) -> str:
    """Parse Letta API response into displayable text.

    Known message_type values:
      reasoning_message — internal chain-of-thought (skipped)
      tool_call_message — tool invocation (skipped)
      tool_return_message — tool result (included if substantial)
      assistant_message — spoken output (always included)

    Also extracts structured artifacts from tool_return_message payloads
    when the content is JSON with a recognized schema (crew results,
    artifact references, etc.).
    """
    messages = data if isinstance(data, list) else data.get("messages", [])
    if not messages:
        return "Secondary agent returned no output."

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
                # Try to extract structured crew results
                try:
                    parsed = _json.loads(str(tool_return)) if isinstance(tool_return, str) else tool_return
                    if isinstance(parsed, dict):
                        # Skip posting an error object as "summary" if the tool
                        # reported {"error": "..."}; fall through to error branch.
                        if "error" in parsed and "artifacts" not in parsed:
                            result_parts.append(f"[Tool error]: {parsed.get('error','')[:500]}")
                        # Crew / image artifact result with summary + artifacts
                        elif "artifacts" in parsed and isinstance(parsed["artifacts"], list):
                            if "summary" in parsed:
                                result_parts.append(str(parsed["summary"]))
                            artifacts.extend(parsed["artifacts"])
                        elif "summary" in parsed:
                            result_parts.append(str(parsed["summary"]))
                        else:
                            result_parts.append(f"[Tool result]: {str(tool_return)[:2000]}")
                    else:
                        result_parts.append(f"[Tool result]: {str(tool_return)[:2000]}")
                except (ValueError, TypeError):
                    result_parts.append(f"[Tool result]: {str(tool_return)[:2000]}")

    text = "\n\n".join(result_parts) if result_parts else ""

    # Append artifact references as structured JSON blocks so the frontend
    # can render them as rich cards. The subtype field distinguishes images
    # (rendered as <img>) from generic file artifacts (rendered as download link).
    if artifacts:
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                continue
            subtype = artifact.get("subtype") or (
                "image" if str(artifact.get("content_type", "")).startswith("image/") else "file"
            )
            image_url = artifact.get("url") or artifact.get("path") or ""
            internal_s3_url = artifact.get("internal_s3_url") or ""
            # Regenerate the presigned URL if this is a recall of a previously
            # stored artifact (internal_s3_url present but URL is empty/stale).
            if subtype == "image" and internal_s3_url and not image_url:
                try:
                    image_url = _regenerate_presigned_url(internal_s3_url)
                except Exception:
                    image_url = ""
            artifact_msg = _json.dumps({
                "type": "artifact",
                "subtype": subtype,
                "title": artifact.get("title", "Artifact"),
                "image_url": image_url if subtype == "image" else "",
                "download_url": image_url,
                "url": image_url,
                "internal_s3_url": internal_s3_url,
                "content_type": artifact.get("content_type", ""),
                "summary": artifact.get("summary", ""),
            })
            text = f"{text}\n\n{artifact_msg}" if text else artifact_msg

    return text or "Task delegated. Secondary agent processed but produced no text output."


def _regenerate_presigned_url(s3_url: str, expires_seconds: int = 86400) -> str:
    """Regenerate a fresh 24h presigned GET URL for an internal S3 URL.

    Called when the agent pod receives an artifact reference (e.g. from
    archival memory recall) that has a permanent s3://bucket/key URL but
    no valid presigned URL. Signs using the MinIO credentials from the
    agent pod's env (MINIO_ACCESS_KEY / MINIO_SECRET_KEY) and the public
    hostname from MINIO_PUBLIC_HOST (default: s3.baisoln.com).

    Args:
        s3_url: "s3://bucket/key/path.png"
        expires_seconds: URL validity in seconds (default 24h)

    Returns:
        A fresh https URL with X-Amz-Signature, or "" on failure.
    """
    import datetime as _dt
    import hashlib
    import hmac
    import os
    import urllib.parse

    if not s3_url.startswith("s3://"):
        return ""
    try:
        rest = s3_url[len("s3://"):]
        bucket, _, key = rest.partition("/")
    except Exception:
        return ""
    if not bucket or not key:
        return ""

    access_key = os.environ.get("MINIO_ACCESS_KEY", "").strip()
    secret_key = os.environ.get("MINIO_SECRET_KEY", "").strip()
    host = os.environ.get("MINIO_PUBLIC_HOST", "s3.baisoln.com").strip()
    region = os.environ.get("MINIO_REGION", "us-east-1").strip()
    if not (access_key and secret_key and host):
        return ""

    service = "s3"
    now = _dt.datetime.utcnow()
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    datestamp = now.strftime("%Y%m%d")
    canonical_uri = "/" + bucket + "/" + urllib.parse.quote(key, safe="/")
    credential_scope = f"{datestamp}/{region}/{service}/aws4_request"
    qp = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{access_key}/{credential_scope}",
        "X-Amz-Date": amz_date,
        "X-Amz-Expires": str(expires_seconds),
        "X-Amz-SignedHeaders": "host",
    }
    canonical_query = "&".join(
        f"{urllib.parse.quote(k, safe='')}={urllib.parse.quote(v, safe='')}"
        for k, v in sorted(qp.items())
    )
    canonical_headers = f"host:{host}\n"
    signed_headers = "host"
    payload_hash = "UNSIGNED-PAYLOAD"
    canonical_request = (
        f"GET\n{canonical_uri}\n{canonical_query}\n"
        f"{canonical_headers}\n{signed_headers}\n{payload_hash}"
    )
    algorithm = "AWS4-HMAC-SHA256"
    string_to_sign = (
        f"{algorithm}\n{amz_date}\n{credential_scope}\n"
        f"{hashlib.sha256(canonical_request.encode()).hexdigest()}"
    )
    k_date = hmac.new(("AWS4" + secret_key).encode("utf-8"), datestamp.encode("utf-8"), hashlib.sha256).digest()
    k_region = hmac.new(k_date, region.encode("utf-8"), hashlib.sha256).digest()
    k_service = hmac.new(k_region, service.encode("utf-8"), hashlib.sha256).digest()
    k_signing = hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"https://{host}{canonical_uri}?{canonical_query}&X-Amz-Signature={signature}"


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
        claims = ctx.token_claims()
        user_label = claims.identity or room_name
        # LiveKit SDK exposes 'name' on claims for the participant display name
        user_display_name = getattr(claims, 'name', '') or getattr(claims, 'metadata', '') or ""
        logger.info("Session user: identity=%s, display_name=%s", user_label, user_display_name)
    except Exception as e:
        logger.info("Could not read token claims: %s", e)
        user_label = room_name
        user_display_name = ""

    # ── Langfuse OTEL tracing (always on) ────────────────────
    trace_provider = setup_langfuse_otel(session_id=room_name)

    # ── Build session with FallbackAdapters ──────────────────
    # turn_detection lives on the AgentSession (NOT on Agent.__init__).
    #
    # preemptive_generation=True — re-enabled now that the primary LLM
    # is OpenRouter (claude-sonnet-4.6) instead of gpu-ai. The original
    # silent hang was specific to gpu-ai's streaming endpoint; OpenRouter
    # streams correctly. Saves ~1s per turn by starting the LLM call
    # during STT instead of after EOU.
    #
    # min_endpointing_delay=0.4 — drop from default ~1.0 so the framework
    # decides 'user is done speaking' faster. Saves ~0.6s per turn at the
    # cost of slightly more interruption mid-thought.
    session = AgentSession(
        stt=create_stt_with_fallback(),
        llm=create_llm_with_fallback(),
        tts=create_tts_with_fallback(),
        vad=silero.VAD.load(),
        turn_detection=MultilingualModel(),
        preemptive_generation=True,
        min_endpointing_delay=0.4,
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

    # ── Create agent early so handlers can reference it ───────
    agent = MainAgent()
    _primary_turn_count = 0  # Track turns to skip greeting forward

    # ── Strict chain-of-command: Primary AI → Assistant ───────
    #
    # The architecture is: the primary voice agent is a Primary AI whose
    # ONLY job is to listen, decide, and speak. The Letta secondary agent
    # is the Assistant — the only entity that does knowledge work and the
    # only entity allowed to publish to the screen (chat data channel).
    #
    # We enforce this by forwarding ONLY the primary AI's spoken turn to
    # Letta (not the raw user STT). That way:
    #   - Letta reacts to what the primary AI decided to teach, not raw input
    #   - The chain of command is unambiguous: user → primary AI → letta → chat
    #   - Letta is never racing the primary AI on user turns
    #
    # Also tracks recent turns for conversation state (Phase 5).
    # Forwarded as a fire-and-forget background task so the voice loop
    # never blocks on Letta latency.
    # Visual-intent keywords that should trigger forwarding of user turns to
    # Letta so it can call generate_image. The primary AI's paraphrase often
    # softens or omits the explicit "show me" request, so we forward the raw
    # user turn as an additional signal when these phrases appear.
    VISUAL_INTENT_KEYWORDS = (
        "show me", "show us", "show ", "see ", "look at", "diagram", "picture",
        "image", "illustration", "drawing", "visualize", "visualise", "draw",
        "sketch", "display", "on screen", "can i see", "what does", "look like",
        "graph", "chart", "plot", "figure",
    )

    @session.on("conversation_item_added")
    def _on_conversation_item(ev: ConversationItemAddedEvent):
        try:
            msg = ev.item
            role = getattr(msg, "role", None)
            text = getattr(msg, "text_content", None)
            if not text or not text.strip():
                return

            # Track all turns (primary AI + user) for conversation context
            label = "Primary AI" if role == "assistant" else "User"
            agent._recent_turns.append(f"[{label}]: {text.strip()[:300]}")

            if role != "assistant":
                # USER turn: normally not forwarded (the chain of command flows
                # user → primary AI → Letta). But when the user explicitly asks
                # for a visual, we forward a marker turn so Letta has the raw
                # intent word-for-word and can call generate_image deterministically.
                lowered = text.strip().lower()
                if any(kw in lowered for kw in VISUAL_INTENT_KEYWORDS):
                    logger.info(
                        "[chain] user visual-intent detected → forwarding to assistant (chars=%d)",
                        len(text),
                    )
                    asyncio.create_task(
                        forward_to_assistant_async("user", text, ctx.room, session),
                        name="letta-forward-user-visual",
                    )
                return

            nonlocal _primary_turn_count
            _primary_turn_count += 1

            # Skip forwarding the first primary AI turn (greeting) to Letta.
            if _primary_turn_count <= 1:
                logger.info("[chain] primary AI greeting (turn %d) — not forwarding to assistant",
                            _primary_turn_count)
                return

            logger.info(
                "[chain] primary AI spoke → forwarding to assistant (chars=%d)",
                len(text),
            )
            asyncio.create_task(
                forward_to_assistant_async("assistant", text, ctx.room, session),
                name="letta-forward-primary",
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
    avatar_active = False
    if settings.avatar_enabled and settings.bithuman_api_key:
        try:
            from livekit.plugins import bithuman
            avatar_kwargs: dict = {
                "api_secret": settings.bithuman_api_secret or settings.bithuman_api_key,
            }
            if settings.bithuman_api_url:
                avatar_kwargs["api_url"] = settings.bithuman_api_url
            if settings.bithuman_avatar_image:
                # Download avatar image to a local file (BitHuman self-hosted may not
                # be able to fetch presigned URLs due to network/hairpin NAT issues)
                try:
                    import tempfile
                    import urllib.request
                    avatar_tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
                    urllib.request.urlretrieve(settings.bithuman_avatar_image, avatar_tmp.name)
                    from PIL import Image
                    avatar_kwargs["avatar_image"] = Image.open(avatar_tmp.name).convert("RGB")
                    logger.info("Downloaded avatar image to %s", avatar_tmp.name)
                except Exception as dl_err:
                    logger.warning("Failed to download avatar image, passing URL: %s", dl_err)
                    avatar_kwargs["avatar_image"] = settings.bithuman_avatar_image
            avatar = bithuman.AvatarSession(**avatar_kwargs)
            await avatar.start(session, room=ctx.room)
            avatar_active = True
            logger.info("BitHuman avatar started (url=%s, image=%s)",
                        settings.bithuman_api_url or "default",
                        settings.bithuman_avatar_image[:50] if settings.bithuman_avatar_image else "none")
        except ImportError:
            logger.warning("livekit-plugins-bithuman not installed — avatar disabled, audio fallback ON")
        except Exception as e:
            logger.warning("Avatar start failed: %s — audio fallback ON", e)

    # ── Room options ─────────────────────────────────────────
    room_opts = room_io.RoomOptions(
        # Vision: feed camera/screen frames to the primary LLM (e.g., Gemma 4 E4B)
        video_input=settings.vision_enabled,
        # Only disable audio output if avatar actually started successfully.
        # If avatar failed, we MUST keep audio output enabled or the agent is mute.
        audio_output=not avatar_active,
    )

    await session.start(
        agent=agent,
        room=ctx.room,
        room_options=room_opts,
    )

    # ── Greeting — primary AI speaks first ────────────────────
    # Try to get user's display name from room participants (more reliable than claims)
    # Wait briefly for user to join the room
    if not user_display_name:
        for _ in range(5):  # Wait up to 2.5s
            for p in ctx.room.remote_participants.values():
                if p.name and not p.identity.startswith("agent-"):
                    user_display_name = p.name
                    logger.info("Got user name from room participant: %s", user_display_name)
                    break
            if user_display_name:
                break
            await asyncio.sleep(0.5)

    is_returning_user = False
    user_name = user_display_name or ""
    user_context = ""

    try:
        if LETTA_AGENT_ID:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as hc:
                resp = await hc.get(
                    f"{LETTA_BASE}/v1/agents/{LETTA_AGENT_ID}",
                    headers=LETTA_HEADERS,
                )
                if resp.status_code < 300:
                    blocks = resp.json().get("memory", {}).get("blocks", [])
                    human_block = next((b for b in blocks if b.get("label") == "human"), None)
                    if human_block:
                        block_text = human_block.get("value", "")
                        if "Preferences:" in block_text and "(none yet)" not in block_text:
                            is_returning_user = True
                            user_context = block_text
    except Exception as e:
        logger.info("Could not read user block for greeting (non-fatal): %s", e)

    # Inject user context into the primary AI's chat context so it knows
    # the user's history, preferences, and prior topics without asking again.
    if user_context or user_name:
        context_msg = "[SYSTEM] User session context:\n"
        if user_name:
            context_msg += f"- User's name: {user_name}\n"
        if user_context:
            context_msg += f"- User memory from previous sessions:\n{user_context}\n"
        context_msg += "Use this context naturally. Do NOT ask for information you already have."
        try:
            session.chat_ctx.add_message(role="system", content=context_msg)
            logger.info("[chain] injected user context into primary AI (%d chars)", len(context_msg))
        except Exception as e:
            logger.info("Could not inject user context (non-fatal): %s", e)

    if is_returning_user and user_name:
        greeting = f"Welcome back, {user_name}! Great to see you again. What would you like to explore today?"
    elif user_name:
        greeting = f"Hello {user_name}! Welcome. How can I help you today?"
    else:
        greeting = "Hello! Welcome. How can I help you today?"

    try:
        await session.say(greeting, allow_interruptions=True)
        logger.info("[chain] primary AI greeting: %s", greeting[:60])
    except Exception as e:
        logger.warning("Greeting failed (non-fatal): %s", e)

    # ── Warm up LLM and TTS in parallel with the user's first words.
    # First-turn latency is dominated by cold paths: OpenRouter takes ~4s
    # TTFT on the first request, gpu-ai TTS pages the model into VRAM on
    # the first synthesize. By kicking off a tiny throwaway request to
    # both at session start (before the user speaks), we eat the cold
    # cost during the otherwise-silent on_enter window.
    async def _warmup_llm() -> None:
        try:
            from livekit.agents import llm as _llm
            # generate one token via a tiny user message — discard result
            ctx_msgs = _llm.ChatContext()
            ctx_msgs.add_message(role="user", content="hi")
            stream = session.llm.chat(chat_ctx=ctx_msgs)
            async for _ in stream:
                pass
            logger.info("[warmup] LLM ready")
        except Exception as e:
            logger.info("[warmup] LLM warmup skipped: %s", e)

    async def _warmup_tts() -> None:
        try:
            stream = session.tts.synthesize("hi")
            async for _ in stream:
                pass
            logger.info("[warmup] TTS ready")
        except Exception as e:
            logger.info("[warmup] TTS warmup skipped: %s", e)

    asyncio.create_task(_warmup_llm(), name="warmup-llm")
    asyncio.create_task(_warmup_tts(), name="warmup-tts")

    if settings.vision_enabled:
        logger.info("Vision enabled — primary LLM receives video frames from user")

    # ── Background audio ────────────────────────────────────
    try:
        from livekit.agents import BackgroundAudioPlayer, AudioConfig, BuiltinAudioClip

        bg_kwargs: dict = {}

        # Ambient sound: download custom URL to temp file, or None
        if settings.ambient_audio_url:
            try:
                import tempfile
                import urllib.request
                ambient_tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
                urllib.request.urlretrieve(settings.ambient_audio_url, ambient_tmp.name)
                bg_kwargs["ambient_sound"] = AudioConfig(ambient_tmp.name, volume=0.3)
                logger.info("Downloaded custom ambient audio to %s (volume=0.3)", ambient_tmp.name)
            except Exception as dl_err:
                logger.warning("Failed to download ambient audio: %s", dl_err)

        # Thinking sound: download custom URL to temp file, or built-in keyboard typing
        if settings.thinking_audio_url:
            try:
                import tempfile
                import urllib.request
                thinking_tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
                urllib.request.urlretrieve(settings.thinking_audio_url, thinking_tmp.name)
                bg_kwargs["thinking_sound"] = thinking_tmp.name
                logger.info("Downloaded custom thinking audio to %s", thinking_tmp.name)
            except Exception as dl_err:
                logger.warning("Failed to download thinking audio, using builtin: %s", dl_err)
        else:
            bg_kwargs["thinking_sound"] = [
                AudioConfig(BuiltinAudioClip.KEYBOARD_TYPING, volume=0.4),
            ]

        bg_audio = BackgroundAudioPlayer(**bg_kwargs)
        await bg_audio.start(room=ctx.room, agent_session=session)
        logger.info("Background audio started (ambient=%s, thinking=%s)",
                     "custom" if settings.ambient_audio_url else "none",
                     "custom" if settings.thinking_audio_url else "builtin")
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
