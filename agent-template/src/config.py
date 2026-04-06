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

    # STT/LLM/TTS configuration (from ConfigMap)
    stt_provider: str = "gpu-ai"
    stt_model: str = ""
    llm_provider: str = "letta"
    llm_model: str = "gpt-4o-mini"
    tts_provider: str = "gpu-ai"
    tts_voice: str = "Sudhir-IndexTTS2"

    # System prompt
    system_prompt: str = ""

    # Letta (from ConfigMap + Vault)
    letta_mcp_url: str = "http://letta-server.letta.svc.cluster.local:8283/mcp"
    letta_agent_name: str = ""
    letta_llm_model: str = "openai-proxy/qwen3.5-27b-fp8"
    letta_system_prompt: str = ""
    letta_api_key: str = ""
    mcp_api_key: str = ""

    # LLM provider keys (from Vault via ESO)
    openai_api_key: str = ""
    custom_llm_base_url: Optional[str] = None
    custom_llm_api_key: Optional[str] = None

    # GPU-AI services
    # Internal cluster URL — avoids Kong hop + TLS overhead
    gpu_ai_mcp_url: str = "http://mcp-ai-mcp-server.mcp.svc.cluster.local:8009/mcp"

    # Avatar
    avatar_enabled: bool = False
    bithuman_api_key: str = ""
    bithuman_api_secret: str = ""
    bithuman_api_url: str = "http://192.168.0.10:8089/launch"

    # Capture
    capture_mode: str = "off"
    capture_interval_seconds: float = 5.0

    # MinIO storage (from Vault via ESO)
    minio_endpoint: str = "minio-tenant-hl.minio.svc.cluster.local:9000"
    minio_access_key: str = ""
    minio_secret_key: str = ""
    minio_bucket: str = ""
    minio_use_ssl: bool = False

    # Langfuse (from Vault via ESO)
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

    # Keycloak (from Vault via ESO)
    # Keycloak: internal for token validation, external for OIDC redirects
    keycloak_url: str = "http://keycloak.keycloak.svc.cluster.local:80"
    keycloak_public_url: str = "https://auth.bionicaisolutions.com"
    keycloak_realm: str = "Bionic"
    keycloak_client_id: str = ""
    keycloak_client_secret: str = ""

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
