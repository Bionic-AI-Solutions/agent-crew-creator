"""Regression tests for finding #12 (high): the delegation worker used
asyncio.wait_for(call, 10s) and, on timeout, RE-issued the same Letta call —
cancelling the first and making Letta run the whole task twice (duplicate image
generation, Dify runs, archival writes). await_once_with_reassurance must invoke
the underlying call exactly once, even when it is slow.

Run: python3 -m pytest agent-template/tests/test_async_utils.py
  or: python3 agent-template/tests/test_async_utils.py
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from agent.async_utils import await_once_with_reassurance  # noqa: E402


def test_calls_underlying_once_when_slow_and_fires_reassurance():
    calls = {"n": 0}
    slow = {"fired": False}

    async def make_call():
        calls["n"] += 1
        await asyncio.sleep(0.05)  # longer than the reassurance threshold
        return "result"

    def on_slow():
        slow["fired"] = True

    result = asyncio.run(await_once_with_reassurance(make_call, 0.01, on_slow))
    assert result == "result"
    assert calls["n"] == 1, f"underlying call must run exactly once, ran {calls['n']}"
    assert slow["fired"] is True, "reassurance should fire when the call is slow"


def test_no_reassurance_when_fast_and_still_one_call():
    calls = {"n": 0}
    slow = {"fired": False}

    async def make_call():
        calls["n"] += 1
        return 42

    result = asyncio.run(
        await_once_with_reassurance(make_call, 1.0, lambda: slow.__setitem__("fired", True))
    )
    assert result == 42
    assert calls["n"] == 1
    assert slow["fired"] is False, "fast call should not trigger reassurance"


if __name__ == "__main__":
    test_calls_underlying_once_when_slow_and_fires_reassurance()
    test_no_reassurance_when_fast_and_still_one_call()
    print("OK: async_utils regression tests passed")
