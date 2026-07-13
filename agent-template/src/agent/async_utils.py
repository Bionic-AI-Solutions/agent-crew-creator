"""Small asyncio helpers with no heavy third-party imports, so they can be
unit-tested in isolation (stdlib only)."""
import asyncio
from typing import Awaitable, Callable, TypeVar

T = TypeVar("T")


async def await_once_with_reassurance(
    make_call: Callable[[], Awaitable[T]],
    slow_after_s: float,
    on_slow: Callable[[], None],
) -> T:
    """Run ``make_call()`` exactly once and return its result.

    If the call has not completed after ``slow_after_s`` seconds, invoke
    ``on_slow()`` (e.g. speak a reassurance message) but keep awaiting the SAME
    in-flight call. This is deliberately NOT ``asyncio.wait_for`` +
    retry: ``wait_for`` cancels the coroutine on timeout, and re-issuing the
    request would make the downstream service (Letta) execute the whole task a
    second time — duplicating side effects like image generation, Dify runs and
    archival writes.
    """
    task = asyncio.ensure_future(make_call())
    done, _ = await asyncio.wait({task}, timeout=slow_after_s)
    if task not in done:
        try:
            on_slow()
        except Exception:
            # Reassurance is best-effort; never let it abort the real call.
            pass
    return await task
