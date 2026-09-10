"""Hold the newest listing of controls on the user's page.

Vision answers what the page looks like. This answers what is on it and what
each thing is called, which is the difference between naming a real control
("click Compose") and describing a location and hoping ("the button near the
top right"). The second is where the observed defects came from: instructions
that went backwards, the same step repeated four times, success claimed before
it happened. None of those survive being able to observe the result instead of
guessing at it.

The widget captures and publishes; this decides what the model is shown. Pure
functions and one small holder, so the rules are testable without a room.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

# A listing that blows the context window is worse than no listing: it is
# re-prefilled on every later turn and buries the few controls that matter.
# Sized to sit well inside a turn's budget alongside a vision frame.
MAX_PAGE_CHARS = 8000

# Older than this and the page is not evidence of anything. A user who walked
# away and came back would otherwise have the agent confidently describing a
# screen that has since changed.
MAX_PAGE_AGE_SECONDS = 120.0


@dataclass
class PageElement:
    ref: str
    role: str
    name: str
    visible: bool


@dataclass
class PageListing:
    url: str = ""
    title: str = ""
    captured_at: float = 0.0
    elements: list[PageElement] = field(default_factory=list)
    truncated: int = 0


def parse_listing(payload: str) -> PageListing | None:
    """Parse a listing published by the widget.

    Returns None rather than raising: the payload arrives over the network
    from a browser, so malformed input is an expected condition and must
    degrade the agent to vision-only rather than dropping the turn.
    """
    try:
        raw: Any = json.loads(payload)
    except (ValueError, TypeError):
        return None
    if not isinstance(raw, dict):
        return None

    elements: list[PageElement] = []
    for item in raw.get("elements") or []:
        if not isinstance(item, dict):
            continue
        ref = str(item.get("ref") or "")
        if not ref:
            continue
        elements.append(
            PageElement(
                ref=ref,
                role=str(item.get("role") or ""),
                name=str(item.get("name") or ""),
                visible=bool(item.get("visible")),
            )
        )

    captured = raw.get("capturedAt")
    return PageListing(
        url=str(raw.get("url") or ""),
        title=str(raw.get("title") or ""),
        # The widget sends epoch milliseconds; everything here is seconds.
        captured_at=float(captured) / 1000.0 if isinstance(captured, (int, float)) else 0.0,
        elements=elements,
        truncated=int(raw.get("truncated") or 0),
    )


def format_for_model(listing: PageListing, max_chars: int = MAX_PAGE_CHARS) -> str:
    """Render a listing as the [PAGE] block attached to a user turn.

    One control per line and nothing else: this text is re-read by the model on
    every subsequent turn, so prose here is paid for repeatedly.

    Truncation drops the controls the user cannot see before those they can,
    since a control below the fold is the least likely one being asked about.
    """
    header = f"[PAGE] {listing.title}\n{listing.url}"
    ordered = [e for e in listing.elements if e.visible] + [
        e for e in listing.elements if not e.visible
    ]

    lines: list[str] = []
    used = len(header)
    dropped = listing.truncated
    for element in ordered:
        name = element.name or "(no name)"
        mark = "" if element.visible else " (off screen)"
        line = f"{element.ref} {element.role} \"{name}\"{mark}"
        if used + len(line) + 1 > max_chars:
            dropped += len(ordered) - len(lines)
            break
        lines.append(line)
        used += len(line) + 1

    body = "\n".join(lines)
    if dropped:
        # Said plainly, so the model does not conclude a control is absent when
        # it was merely cut.
        body += f"\n({dropped} more controls not listed)"
    return f"{header}\n{body}"


class PageHolder:
    """The newest listing, and whether it is still worth showing.

    Deliberately holds ONE listing rather than a history. Refs are renumbered
    by every capture, so an older listing's refs describe a page that no longer
    exists -- keeping them around would let the agent act on a ref that now
    points at something else.
    """

    def __init__(self, max_age: float = MAX_PAGE_AGE_SECONDS) -> None:
        self._listing: PageListing | None = None
        self._received_at: float = 0.0
        self._max_age = max_age

    def update(self, payload: str, now: float | None = None) -> bool:
        """Take a newly published listing. False if it was unusable."""
        listing = parse_listing(payload)
        if listing is None:
            return False
        self._listing = listing
        self._received_at = time.monotonic() if now is None else now
        return True

    def clear(self) -> None:
        """Forget the page, e.g. when the user stops sharing it."""
        self._listing = None
        self._received_at = 0.0

    def current(self, now: float | None = None) -> PageListing | None:
        """The listing, if there is one and it is not stale."""
        if self._listing is None:
            return None
        current = time.monotonic() if now is None else now
        if current - self._received_at > self._max_age:
            return None
        return self._listing

    def block_for_turn(self, now: float | None = None) -> str | None:
        """The [PAGE] text to attach to this turn, or None."""
        listing = self.current(now)
        if listing is None or not listing.elements:
            return None
        return format_for_model(listing)
