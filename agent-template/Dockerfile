FROM python:3.11-slim AS base

WORKDIR /app

# Install system dependencies (git needed for git+https pip installs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy pre-built flashhead wheel (avoids needing GitHub auth in the build)
COPY livekit_plugins_flashhead-0.3.6-py3-none-any.whl ./

# Install Python dependencies
RUN pip install --no-cache-dir \
    "livekit-agents>=1.5.0" \
    "livekit-plugins-silero>=1.0.0" \
    "livekit-plugins-openai>=1.0.0" \
    "livekit-plugins-turn-detector>=1.0.0" \
    "pydantic-settings>=2.0.0" \
    "httpx>=0.27.0" \
    "langfuse>=3.0.0" \
    "opentelemetry-sdk>=1.20.0" \
    "opentelemetry-exporter-otlp-proto-http>=1.20.0" \
    "opentelemetry-instrumentation-httpx>=0.44b0" \
    "livekit-plugins-deepgram>=1.0.0" \
    "livekit-plugins-cartesia>=1.0.0" \
    "livekit-plugins-elevenlabs>=1.0.0" \
    "livekit-plugins-sarvam>=1.6.0" \
    # Avatar — FlashHead (default, pre-built wheel) + BitHuman (legacy)
    "./livekit_plugins_flashhead-0.3.6-py3-none-any.whl" \
    "livekit-plugins-bithuman>=0.1.0" \
    # Async TTS — streaming-first, low-latency
    "livekit-plugins-asyncai>=1.5.0" \
    # Capture (frame → PNG) and storage
    "Pillow>=10.0.0" \
    "minio>=7.2.0"

# Copy source
COPY src/ ./src/

ENV PYTHONPATH=/app/src
ENV PYTHONUNBUFFERED=1

# Pre-download model files for turn-detector, silero VAD, etc.
# Uses livekit-agents' built-in `download-files` subcommand from
# cli.run_app(WorkerOptions(...)), which calls each registered plugin's
# download_files() hook to fetch ONNX models, VAD weights, etc. into the
# image so the worker doesn't have to fetch them on first job (which it
# can't anyway — MultilingualModel() needs a job context to instantiate).
#
# This step REQUIRES network access at build time and will fail loudly
# if HuggingFace / model CDN is unreachable. We deliberately DO NOT
# silence errors here — a missing model file silently breaks every
# dispatch (turn detector init crashes), and we'd rather fail the build.
#
# Minimal env vars so settings.py / config.py boot without throwing
# (real values come from K8s ConfigMap at runtime).
ENV APP_SLUG=build-noop \
    AGENT_NAME=build-noop \
    LETTA_BASE_URL=http://localhost \
    LETTA_MCP_URL=http://localhost/mcp \
    LIVEKIT_URL=ws://localhost \
    LIVEKIT_API_KEY=build-noop \
    LIVEKIT_API_SECRET=build-noop-build-noop-build-noop-noop
RUN python src/agent/main_agent.py download-files

ENTRYPOINT ["python", "src/agent/main_agent.py"]
CMD ["start"]
