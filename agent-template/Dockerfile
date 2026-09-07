FROM python:3.11-slim AS base

WORKDIR /app

# Install system dependencies (git needed for git+https pip installs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy pre-built flashhead wheel (avoids needing GitHub auth in the build)
COPY livekit_plugins_flashhead-0.5.2-py3-none-any.whl ./

# Install Python dependencies
#
# The livekit runtime is pinned EXACTLY, not floated. a586d1e pinned
# pyproject.toml to stop "the 2026-09-06 image silently went 1.7.1 -> 1.8.0
# with no code change" -- but this file never reads pyproject.toml, so the pin
# had no effect on the image and the runtime kept floating. The versions below
# are the enforcement point; the check further down makes the two agree.
#
# The agents core and its first-party plugins ship in lockstep on one version
# number, so they move together or not at all. Bump them deliberately, and
# bump pyproject.toml in the same commit.
RUN pip install --no-cache-dir \
    "livekit-agents==1.8.0" \
    "livekit-plugins-silero==1.8.0" \
    "livekit-plugins-openai==1.8.0" \
    "livekit-plugins-turn-detector==1.8.0" \
    "pydantic-settings>=2.0.0" \
    "httpx>=0.27.0" \
    "langfuse>=3.0.0" \
    "opentelemetry-sdk>=1.20.0" \
    "opentelemetry-exporter-otlp-proto-http>=1.20.0" \
    "opentelemetry-instrumentation-httpx>=0.44b0" \
    "livekit-plugins-deepgram==1.8.0" \
    "livekit-plugins-cartesia==1.8.0" \
    "livekit-plugins-elevenlabs==1.8.0" \
    # Pinned exact: the 7-voice list + bulbul:v2 model pin in plugins.py
    # are verified against this version's speaker-compatibility table.
    "livekit-plugins-sarvam==1.6.5" \
    # Avatar — FlashHead (default, pre-built wheel) + BitHuman (legacy)
    "./livekit_plugins_flashhead-0.5.2-py3-none-any.whl" \
    "livekit-plugins-bithuman==1.8.0" \
    # Async TTS — streaming-first, low-latency
    "livekit-plugins-asyncai==1.8.0" \
    # Capture (frame → PNG) and storage
    "Pillow>=10.0.0" \
    "minio>=7.2.0"

# Fail the build if pyproject.toml and the image disagree.
#
# Two files declare these versions and only this one installs them, so they can
# drift silently -- which is exactly what happened: pyproject said 1.8.0 while
# the image floated. Copying pyproject.toml AFTER the install is deliberate.
# Editing it does not invalidate the pip layer above, so a bump made only there
# leaves the installed version untouched and this check fails loudly instead of
# shipping a lie.
COPY pyproject.toml ./
RUN python - <<'PYCHECK'
import re, sys, tomllib
from importlib.metadata import PackageNotFoundError, version

with open("pyproject.toml", "rb") as fh:
    project = tomllib.load(fh)["project"]

requirements = list(project.get("dependencies", []))
for extra in project.get("optional-dependencies", {}).values():
    requirements += extra

# Only exact pins are enforceable; a ">=" range is satisfied by whatever pip
# picked, which is the freedom this check is not trying to remove.
mismatched = []
for requirement in requirements:
    pin = re.match(r"^([A-Za-z0-9._-]+)==([0-9][^\s;]*)$", requirement.strip())
    if not pin:
        continue
    name, expected = pin.group(1), pin.group(2)
    try:
        installed = version(name)
    except PackageNotFoundError:
        continue          # an extra this image does not install
    if installed != expected:
        mismatched.append(f"  {name}: pyproject pins {expected}, image has {installed}")

if mismatched:
    sys.exit("pyproject.toml disagrees with the installed runtime:\n"
             + "\n".join(mismatched)
             + "\n\nBump the pip install above and pyproject.toml together.")
print("dependency pins agree with pyproject.toml")
PYCHECK

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
