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
import unicodedata
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

# Longest accessible name kept. The widget caps this too, but the payload
# crosses the network from a browser, so this side does not take its word for
# it -- the whole point of the cap is that the value is chosen by the page.
MAX_NAME_CHARS = 120

# How the [PAGE] block starts. Anything that begins with this is page-authored
# text, not something a person said, and callers use it to tell the two apart.
PAGE_BLOCK_PREFIX = "[PAGE]"

# The widget already caps at 200. Re-applied here because the widget is not
# the only thing that can publish to the topic, and because "bounded on
# arrival" should mean bounded, not bounded in length only.
MAX_ELEMENTS = 200

# How many raw entries are examined before giving up. Junk entries do not
# count toward MAX_ELEMENTS, so without this a payload of a million nulls
# would be walked in full.
MAX_RAW_ELEMENTS = 2000

# Largest "N more controls not listed" this will print. The number itself is
# page-authored, so left alone it can be long enough to blow the budget the
# rest of the block was carefully fitted into.
MAX_REPORTED_DROPPED = 99_999

# First-pass reserve for the trailing "(N more...)" line. Not load-bearing on
# its own -- format_for_model measures the finished block and gives lines back
# until it fits -- but it means the common case gets there in one pass.
SUFFIX_RESERVE = 48


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


# Invisibles that Unicode does not classify as a format character: the
# combining grapheme joiner, the Hangul and Khmer fillers, the blank braille
# pattern. Everything else comes from the category itself.
_EXTRA_INVISIBLE = frozenset(
    "\u034f\u115f\u1160\u17b4\u17b5\u2800\u3164\uffa0"
)

# Format characters this Python does not yet know are format characters.
#
# The two cleaners run on different Unicode versions -- the agent image ships
# Python 3.11 (Unicode 14) while the browser's regex uses the runtime's ICU
# (Unicode 17 on current Node) -- so asking each runtime for the category is
# not the same question on both sides. The Egyptian hieroglyph format controls
# became Cf in Unicode 15; here they still read as unassigned.
#
# Whenever the two disagree the newer answer wins, because the disagreement
# always means the older table has not caught up. This set is the bridge, and
# it should shrink to nothing the next time this image's Python moves.
_CF_AFTER_UNICODE_14 = frozenset(chr(cp) for cp in range(0x13430, 0x13440))


def _is_invisible(ch: str) -> bool:
    """Characters that occupy no space, and so cannot be read.

    Asks Unicode whether the character is a format character rather than
    listing ranges by hand. The hand-written version missed soft hyphen, the
    Arabic letter mark, the interlinear annotation marks and the whole tag
    block -- and a list assembled from memory is exactly as complete as the
    memory that assembled it.

    Must agree exactly with the browser's regex: two cleaners that disagree
    about a character mean one of them is wrong.
    """
    return (
        unicodedata.category(ch) == "Cf"
        or ch in _EXTRA_INVISIBLE
        or ch in _CF_AFTER_UNICODE_14
    )


def _clean(raw: str, limit: int) -> str:
    """Flatten a page-authored string so it cannot forge structure.

    The listing becomes one line per control in the model's context. A value
    containing a newline could forge a line -- a second [PAGE] block, invented
    refs, invented rules -- and it would be indistinguishable from the real
    thing, because it would BE the real thing by the time the model saw it.
    Collapsing whitespace removes the ability to forge a line rather than
    relying on the model to disbelieve one.
    """
    # str.split() alone is not enough: it splits on whitespace, and NUL, BEL
    # and friends are not whitespace, so they survived into the listing. Map
    # every control character to a space first, then collapse.
    # The same range the browser strips (C0, DEL, and C1). These two
    # implementations clean the same string, so a character one removes and
    # the other keeps means one of them is wrong -- C1 (0x80-0x9f) was kept
    # here and stripped there.
    # Lone surrogates go too. They survive JSON, but the resulting string
    # cannot be encoded as UTF-8 at all -- a "\ud800" in the title produced a
    # block that raised UnicodeEncodeError on its way anywhere. json.dumps
    # happens to neutralise them inside `name`; the header is not quoted, so
    # nothing was neutralising them there.
    mapped = "".join(
        ""
        if _is_invisible(ch)
        else " "
        if ch < " " or "\x7f" <= ch <= "\x9f" or "\ud800" <= ch <= "\udfff"
        else ch
        for ch in raw
    )
    flat = " ".join(mapped.split())
    return flat[:limit] if len(flat) > limit else flat


def _bounded_count(value: Any) -> int:
    """A count from the wire, forced into a range that can be printed."""
    try:
        count = int(value or 0)
    except (ValueError, TypeError):
        return 0
    return max(0, min(count, MAX_REPORTED_DROPPED))


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

    # Bound the walk itself, not only its output. Junk entries are skipped
    # without counting toward the element cap, so a payload of a million
    # non-objects would otherwise be walked in full.
    raw_elements = raw.get("elements") or []
    if not isinstance(raw_elements, list):
        raw_elements = []
    considered = raw_elements[:MAX_RAW_ELEMENTS]
    dropped_by_cap = len(raw_elements) - len(considered)

    elements: list[PageElement] = []
    for item in considered:
        # Validity is checked BEFORE the cap, so junk past the 200th control
        # is not counted as a control. Counting it inverted the defect this
        # counter was added to fix: instead of hiding controls that existed,
        # it claimed controls that never did, and the agent would go looking.
        if not isinstance(item, dict):
            continue
        ref = str(item.get("ref") or "")
        if not ref:
            continue
        if len(elements) >= MAX_ELEMENTS:
            # Counted, not silently discarded. Dropping elements without
            # saying so is what makes the model believe it saw the whole page
            # -- and then tell the user a control does not exist.
            dropped_by_cap += 1
            continue
        elements.append(
            PageElement(
                # Every one of these is written by the page, so every one is
                # flattened and bounded here regardless of what the widget did.
                ref=_clean(ref, 40),
                role=_clean(str(item.get("role") or ""), 40),
                name=_clean(str(item.get("name") or ""), MAX_NAME_CHARS),
                visible=bool(item.get("visible")),
            )
        )

    captured = raw.get("capturedAt")
    return PageListing(
        url=_clean(str(raw.get("url") or ""), 300),
        title=_clean(str(raw.get("title") or ""), 200),
        # The widget sends epoch milliseconds; everything here is seconds.
        captured_at=float(captured) / 1000.0 if isinstance(captured, (int, float)) else 0.0,
        elements=elements,
        # Clamped, because this arrives from the wire like everything else.
        # Unbounded, it defeated the very budget it is supposed to fit inside:
        # a 4290-digit `truncated` rendered a "(N more...)" line thousands of
        # characters long, and the block overshot max_chars by 2968.
        # Clamped as a total. Clamping only the wire term left the other
        # addend -- the unexamined tail past MAX_RAW_ELEMENTS -- uncapped, so
        # the two together sailed past the bound the clamp exists to hold.
        truncated=min(
            _bounded_count(raw.get("truncated")) + dropped_by_cap,
            MAX_REPORTED_DROPPED,
        ),
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

    def render(kept: list[str], dropped_count: int) -> str:
        body = "\n".join(kept)
        if dropped_count:
            # Said plainly, so the model does not conclude a control is absent
            # when it was merely cut.
            suffix = f"({dropped_count} more controls not listed)"
            body = f"{body}\n{suffix}" if body else suffix
        return f"{header}\n{body}" if body else header

    lines: list[str] = []
    # A reserve is a guess, and a guess is not a bound: the suffix length
    # depends on a page-authored count, so reserving a fixed 40 characters for
    # it let the block overshoot by thousands. The reserve stays as a cheap
    # first pass, and the loop below turns it into an actual guarantee.
    used = len(header) + SUFFIX_RESERVE
    dropped = listing.truncated
    for element in ordered:
        name = element.name or "(no name)"
        mark = "" if element.visible else " (off screen)"
        # json.dumps rather than an f-string quote: it escapes any quote or
        # backslash in the name, so a control cannot close its own field and
        # write whatever it likes after it.
        line = f"{element.ref} {element.role} {json.dumps(name)}{mark}"
        if used + len(line) + 1 > max_chars:
            # Skip this one and keep going, rather than stopping. Stopping let
            # a single oversized name hide every control after it -- one
            # attribute on one element blanked the agent's whole view of the
            # page, and the controls that mattered were usually later.
            dropped += 1
            continue
        lines.append(line)
        used += len(line) + 1

    # Now measure what was actually produced, and give back lines until it
    # fits. Every line surrendered raises the dropped count, which can itself
    # lengthen the suffix, so this loops rather than adjusting once.
    while lines and len(render(lines, dropped)) > max_chars:
        lines.pop()
        dropped += 1

    rendered = render(lines, dropped)
    # A header longer than the whole budget is the only way to still be over,
    # and a truncated header beats an unbounded one.
    return rendered if len(rendered) <= max_chars else rendered[:max_chars]


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
