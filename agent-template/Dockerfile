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
    "./livekit_plugins_flashhead-0.3.6-py3-none-any.whl" \
    "Pillow>=10.0.0" \
    "minio>=7.2.0"

# Copy source
COPY src/ ./src/

ENV PYTHONPATH=/app/src
ENV PYTHONUNBUFFERED=1

# Download turn detector model files at build time
RUN python -c "from livekit.plugins.turn_detector.multilingual import MultilingualModel; MultilingualModel()" 2>/dev/null || true

ENTRYPOINT ["python", "src/agent/main_agent.py"]
CMD ["start"]
