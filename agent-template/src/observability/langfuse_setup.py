"""Langfuse client bootstrap.

Vault/ESO injects ``LANGFUSE_PUBLIC_KEY`` and ``LANGFUSE_SECRET_KEY`` into each app
namespace's Secret (see ``k8sClient.applyAgentDeployment``). Those keys are created per
app when the Langfuse project is provisioned (``langfuseAdmin.createProject``), so they
always target the correct Langfuse project for that tenant.

ConfigMap sets ``LANGFUSE_HOST`` (same as ``LANGFUSE_BASE_URL`` for the SDK). The Python
SDK also reads ``LANGFUSE_HOST`` from the environment.
"""

from __future__ import annotations

import logging
from config import settings

logger = logging.getLogger("observability.langfuse")

_initialized = False


def clip_attr(value: object, max_len: int = 200) -> str:
    """Langfuse propagated attributes must be ASCII strings ≤200 chars."""
    s = str(value) if value is not None else ""
    return s.encode("ascii", errors="replace").decode("ascii")[:max_len]


def is_langfuse_enabled() -> bool:
    return bool(settings.langfuse_public_key and settings.langfuse_secret_key)


def init_langfuse() -> None:
    """Register the Langfuse singleton for this process using explicit credentials.

    Using :class:`langfuse.Langfuse` with keys from :class:`config.Settings` ensures the
    same project as Vault/ESO, whether or not generic env vars are present.
    """
    global _initialized
    if _initialized:
        return
    _initialized = True

    if not is_langfuse_enabled():
        logger.info(
            "Langfuse credentials not set (LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY) — tracing disabled"
        )
        return

    from langfuse import Langfuse

    Langfuse(
        public_key=settings.langfuse_public_key,
        secret_key=settings.langfuse_secret_key,
        host=settings.langfuse_host,
        environment=(settings.app_env or None),
    )
    logger.info(
        "Langfuse initialized for tenant project (pk prefix=%s…)",
        settings.langfuse_public_key[:16],
    )


def flush_langfuse() -> None:
    """Best-effort flush of batched Langfuse events (call on job shutdown)."""
    if not is_langfuse_enabled():
        return
    try:
        from langfuse import get_client

        get_client(public_key=settings.langfuse_public_key).flush()
    except Exception:
        logger.debug("Langfuse flush failed", exc_info=True)
