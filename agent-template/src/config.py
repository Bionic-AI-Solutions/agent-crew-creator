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
    llm_provider: str = "gpu-ai"
    llm_model: str = "gemma-4-e4b"
    custom_llm_base_url: Optional[str] = None
    custom_llm_api_key: Optional[str] = None

    # ── Secondary brain (Letta — powerful executor) ──────────────
    letta_base_url: str = "http://letta-server.letta.svc.cluster.local:8283"
    letta_agent_name: str = ""
    letta_agent_id: str = ""
    letta_llm_model: str = "openai-proxy/qwen3.5-27b-fp8"
    letta_system_prompt: str = ""
    letta_api_key: str = ""
    letta_server_password: str = ""
    mcp_api_key: str = ""

    # ── STT/TTS configuration ────────────────────────────────────
    stt_provider: str = "gpu-ai"
    stt_model: str = ""
    tts_provider: str = "gpu-ai"
    tts_voice: str = "Sudhir-IndexTTS2"
    tts_model: str = "tts-1"

    # ── Fallback providers (keys from Vault, not user-configurable) ──
    deepgram_api_key: str = ""
    openai_api_key: str = ""
    openrouter_api_key: str = ""
    anthropic_api_key: str = ""
    cartesia_api_key: str = ""
    elevenlabs_api_key: str = ""
    async_api_key: str = ""

    # System prompt (primary agent)
    system_prompt: str = ""

    # GPU-AI services
    # MCP endpoint — for tool calls via Model Context Protocol
    gpu_ai_mcp_url: str = "http://mcp-ai-mcp-server.mcp.svc.cluster.local:8009/mcp"
    # OpenAI-compatible LLM/STT/TTS endpoint — different service from the MCP
    # server. mcp-api-server routes by model suffix (gemma → llm-fast,
    # qwen3.5-*-think → llm-deep, etc.). Used by plugins.py for STT/TTS/LLM.
    gpu_ai_llm_url: str = "http://mcp-api-server.mcp.svc.cluster.local:8000"

    # Avatar (BitHuman)
    avatar_enabled: bool = False
    bithuman_api_key: str = ""
    bithuman_api_secret: str = ""
    bithuman_api_url: str = "http://192.168.0.10:8089/launch"
    bithuman_livekit_url: str = ""  # External LiveKit URL for BitHuman (set from Vault shared/bithuman)
    bithuman_avatar_image: str = ""

    # Vision (feed camera/screen frames to the primary LLM)
    vision_enabled: bool = False

    # Background audio
    background_audio_enabled: bool = False
    busy_audio_enabled: bool = False
    ambient_audio_url: str = ""    # Custom ambient sound (loop) — presigned MinIO URL
    thinking_audio_url: str = ""   # Custom thinking sound — presigned MinIO URL

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
