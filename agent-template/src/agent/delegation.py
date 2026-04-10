"""Lightweight in-process delegation registry.

Tracks active background delegations to Letta so we can:
- Cancel stale tasks when the user changes topic or fires a new delegation
- Enforce deadlines with partial-result return on timeout
- Provide correlation IDs for tracing (Langfuse)
- Report progress to the chat channel
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Optional
from uuid import uuid4

logger = logging.getLogger("delegation")


@dataclass
class DelegationTask:
    """A tracked background delegation."""
    task_id: str
    task_description: str
    created_at: float
    asyncio_task: Optional[asyncio.Task] = None
    status: str = "pending"  # pending | running | completed | cancelled | timeout | error
    partial_result: str = ""


class DelegationRegistry:
    """Manages active delegation tasks for one agent session.

    Only one explicit delegation is active at a time — starting a new one
    cancels the previous. Proactive forwards (fire-and-forget) are NOT
    tracked here; they don't need cancellation or progress.
    """

    def __init__(self):
        self._active: Optional[DelegationTask] = None
        self._history: list[DelegationTask] = []

    def reserve(self, description: str) -> DelegationTask:
        """Reserve a new delegation slot, cancelling/archiving any active one.

        Call launch() after to actually start the work. This two-step pattern
        lets callers embed the correlation ID in the request before launching.

        Returns:
            The reserved DelegationTask (status="pending").
        """
        # Cancel or archive any active delegation
        if self._active:
            if self._active.status == "running":
                self.cancel_active("superseded by new delegation")
            else:
                # Completed/errored/timed-out — move to history
                self._history.append(self._active)
                self._active = None

        task_id = uuid4().hex[:12]
        entry = DelegationTask(
            task_id=task_id,
            task_description=description[:200],
            created_at=time.monotonic(),
            status="pending",
        )
        self._active = entry
        return entry

    def launch(self, entry: DelegationTask, coro, *, deadline_ms: int = 0) -> None:
        """Launch the actual work for a reserved delegation entry.

        Args:
            entry: The DelegationTask from reserve().
            coro: The coroutine to run.
            deadline_ms: If > 0, wraps the coro in asyncio.wait_for.
                         When wait_for fires, a timeout chat message is
                         NOT automatically posted — the caller's coro must
                         handle its own cleanup before cancellation.
        """
        entry.status = "running"

        # Wrap with deadline if specified
        if deadline_ms > 0:
            async def _with_deadline():
                try:
                    await asyncio.wait_for(coro, timeout=deadline_ms / 1000)
                except asyncio.TimeoutError:
                    entry.status = "timeout"
                    logger.warning(
                        "Delegation %s timed out after %dms: %s",
                        entry.task_id, deadline_ms, entry.task_description[:100],
                    )
            wrapped = _with_deadline()
        else:
            wrapped = coro

        async def _tracked():
            try:
                await wrapped
                if entry.status == "running":
                    entry.status = "completed"
            except asyncio.CancelledError:
                if entry.status == "timeout":
                    # wait_for sets timeout then raises CancelledError;
                    # preserve the "timeout" status set by _with_deadline.
                    pass
                else:
                    entry.status = "cancelled"
                    logger.info("Delegation %s cancelled: %s",
                                entry.task_id, entry.task_description[:100])
            except Exception as e:
                entry.status = "error"
                logger.error("Delegation %s failed: %s", entry.task_id, e)

        entry.asyncio_task = asyncio.create_task(
            _tracked(), name=f"delegation-{entry.task_id}"
        )
        logger.info(
            "Delegation launched: id=%s desc=%s deadline=%dms",
            entry.task_id, entry.task_description[:100], deadline_ms,
        )

    def start(self, description: str, coro, *, deadline_ms: int = 0) -> DelegationTask:
        """Convenience: reserve + launch in one call."""
        entry = self.reserve(description)
        self.launch(entry, coro, deadline_ms=deadline_ms)
        return entry

    def cancel_active(self, reason: str = "") -> bool:
        """Cancel the currently active delegation if any.

        Returns True if a task was cancelled.
        """
        if not self._active or self._active.status != "running":
            return False

        task = self._active
        if task.asyncio_task and not task.asyncio_task.done():
            task.asyncio_task.cancel()
        task.status = "cancelled"
        self._history.append(task)
        self._active = None
        logger.info(
            "Delegation %s cancelled: %s (reason: %s)",
            task.task_id, task.task_description[:100], reason,
        )
        return True

    @property
    def active_task(self) -> Optional[DelegationTask]:
        """Return the currently active delegation, if any."""
        if self._active and self._active.status == "running":
            return self._active
        return None

    @property
    def active_task_id(self) -> str:
        """Convenience: return the active task's ID or empty string."""
        return self._active.task_id if self._active else ""
