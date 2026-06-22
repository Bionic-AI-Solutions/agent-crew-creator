# Agent runtime template (`agent-template/`)

Python sources for the **agent worker** container image. The platform deploys this image into each app namespace with configuration from `server/services/agentDeployer.ts`.

## Layout

| Path | Role |
|------|------|
| `agent-template/Dockerfile` | Image build |
| `agent-template/pyproject.toml` | Python dependencies (Poetry-friendly layout) |
| `agent-template/src/config.py` | Settings and environment wiring |
| `agent-template/src/agent/main_agent.py` | Primary LiveKit and Letta agent loop |
| `agent-template/src/agent/plugins.py` | Tool plugins |
| `agent-template/src/agent/delegation.py` | Delegation patterns |
| `agent-template/src/agent/orchestrator.py` | HTTP calls to Dify workflow API for crews |
| `agent-template/src/tools/generate_image.py` | Image generation tool |
| `agent-template/src/observability/langfuse_setup.py` | Langfuse hooks |

## Runtime contract (summary)

- Worker registers with LiveKit using **`AGENT_NAME`** (must match `RoomAgentDispatch.agentName` from tokens minted by the platform: `${slug}-${agent.name}`).
- Environment variables inject LLM, STT, TTS, Letta, MinIO, and optional GPU endpoints (see deployer and Vault).

## Local development artifacts

- Directories such as `agent-template/.letta/` may hold local session JSON. Do not bake secrets into images; use `.dockerignore` where appropriate.
