"""Application configuration loaded from environment variables.

All secrets are injected via Vault/ESO -> K8s Secret -> env vars.
Non-secret config comes from K8s ConfigMap -> env vars.
"""

from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    # App identity (from ConfigMap)
    app_slug: str = "test-agent"
    app_env: str = "development"
    agent_name: str = "default-agent"

    # LiveKit (from Vault via ESO)
    livekit_url: str = "ws://livekit-server.livekit.svc.cluster.local:7880"
    livekit_api_key: str = ""
    livekit_api_secret: str = ""

    # ── Primary brain (fast, user-facing voice LLM) ──────────────
    # Default: Qwen 3.6 35B (no-think) — best voice-latency/quality
    # tradeoff on gpu-ai. Use -think suffix for derivation/reasoning.
    llm_provider: str = "gpu-ai"
    llm_model: str = "qwen3.6-35b-a3b-fp8"
    custom_llm_base_url: Optional[str] = None
    custom_llm_api_key: Optional[str] = None

    # ── Secondary brain (Letta — powerful executor) ──────────────
    # Default: Qwen 3.6 with thinking ON — Letta handles multi-step
    # reasoning, tool chains, and crew orchestration where CoT pays off.
    letta_base_url: str = "http://letta-server.letta.svc.cluster.local:8283"
    letta_agent_name: str = ""
    letta_agent_id: str = ""
    letta_llm_model: str = "openai-proxy/qwen3.6-35b-a3b-fp8-think"
    letta_system_prompt: str = ""
    letta_api_key: str = ""
    mcp_api_key: str = ""

    # ── STT/TTS configuration ────────────────────────────────────
    stt_provider: str = "gpu-ai"
    stt_model: str = ""
    tts_provider: str = "gpu-ai"
    tts_voice: str = "Sudhir-IndexTTS2"

    # ── Fallback providers (keys from Vault, not user-configurable) ──
    deepgram_api_key: str = ""
    openai_api_key: str = ""
    cartesia_api_key: str = ""

    # System prompt (primary agent)
    system_prompt: str = ""

    # GPU-AI services
    gpu_ai_mcp_url: str = "http://mcp-ai-mcp-server.mcp.svc.cluster.local:8009/mcp"
    gpu_ai_llm_base_url: str = "http://llm-deep.mcp.svc.cluster.local:8005/v1"
    gpu_ai_stt_base_url: str = "http://mcp-api-server.mcp.svc.cluster.local:8000/v1"
    gpu_ai_tts_base_url: str = "http://mcp-api-server.mcp.svc.cluster.local:8000/v1"
    # External gpu-ai key (optional — only needed when the agent points
    # at the public https://mcp.baisoln.com/gpu-ai/v1 gateway rather
    # than the in-cluster ClusterIP). Not required for in-cluster paths.
    gpu_ai_key: str = ""

    # ── Avatar ───────────────────────────────────────────────────
    # avatar_provider selects the rendering backend when avatar_enabled:
    #   "flashhead" (default)  — SoulX-FlashHead via in-cluster
    #                            flashhead-engine (WebSocket, shared)
    #   "bithuman"             — legacy BitHuman runtime (optional)
    avatar_enabled: bool = False
    avatar_provider: str = "flashhead"
    # Shared cluster endpoint for the flashhead-engine service. Set via
    # the platform ConfigMap (see deploy/.../manifests/bionic-platform).
    flashhead_engine_url: str = "ws://avatar-service.live-avatar.svc.cluster.local:8080/v1/session"
    # Per-agent default face (https URL or container path). Can be
    # overridden at dispatch time via job metadata {"reference_image": ...}.
    flashhead_reference_image: str = ""
    flashhead_avatar_name: str = "Avatar"
    # Legacy BitHuman (kept for backward compat with existing agents).
    bithuman_api_key: str = ""
    bithuman_api_secret: str = ""
    bithuman_api_url: str = "http://192.168.0.10:8089/launch"

    # Vision (feed camera/screen frames to the primary LLM)
    vision_enabled: bool = False

    # Background audio (thinking sounds)
    background_audio_enabled: bool = False

    # Capture (periodic frame storage to MinIO, separate from vision)
    capture_mode: str = "off"
    capture_interval_seconds: float = 5.0

    # MinIO storage (from Vault via ESO)
    minio_endpoint: str = "minio-tenant-hl.minio.svc.cluster.local:9000"
    minio_access_key: str = ""
    minio_secret_key: str = ""
    minio_bucket: str = ""
    minio_use_ssl: bool = False

    # Langfuse
    langfuse_host: str = "http://langfuse-web.langfuse.svc.cluster.local:3000"
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""

    # Dynamic configuration (from ConfigMap, JSON strings)
    enabled_tools: str = "[]"
    mcp_servers: str = "[]"
    enabled_crews: str = "[]"
    crew_registry: str = "[]"

    # Dify crew engine (from ConfigMap)
    dify_base_url: str = ""
    dify_web_url: str = ""
    dify_api_key: str = ""

    # Letta MCP URL
    letta_mcp_url: str = "http://letta-server.letta.svc.cluster.local:8283/mcp"

    # Keycloak (from Vault via ESO)
    keycloak_url: str = "http://keycloak.keycloak.svc.cluster.local:80"
    keycloak_public_url: str = "https://auth.bionicaisolutions.com"
    keycloak_realm: str = "Bionic"
    keycloak_client_id: str = ""
    keycloak_client_secret: str = ""

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
