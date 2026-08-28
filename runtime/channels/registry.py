"""tool string -> adapter. The dispatch table.

Adding a transport is a row here, not a branch anywhere else. Two of the rows
below point at the same class with different action slugs, which is the concrete
form of the claim: providers sitting behind one integration layer differ by slug
and payload shape, not by transport mechanics.
"""
from __future__ import annotations

from typing import Any, Callable

from .base import Channel
from .composio import ComposioChannel
from .http import HttpChannel

#: Each entry builds a channel for one `channel.tool` value.
ADAPTERS: dict[str, Callable[[], Channel]] = {
    "composio.gmail": lambda: ComposioChannel(
        "composio.gmail",
        {
            "fetch": "GMAIL_FETCH_EMAILS",
            "send": "GMAIL_SEND_EMAIL",
            "attachment": "GMAIL_GET_ATTACHMENT",
        },
    ),
    "composio.slack": lambda: ComposioChannel(
        "composio.slack",
        {
            "fetch": "SLACK_FETCH_CONVERSATION_HISTORY",
            "send": "SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL",
            "attachment": "SLACK_FETCH_FILE_INFO",
        },
    ),
    "http.get": lambda: HttpChannel("http.get"),
}


def resolve(tool: str) -> Channel:
    adapter = ADAPTERS.get(tool)
    if adapter is None:
        raise KeyError(
            f"no adapter for tool {tool!r}. Known: {', '.join(sorted(ADAPTERS))}. "
            "Adding one is a row in runtime/channels/registry.py."
        )
    return adapter()


def known() -> list[str]:
    return sorted(ADAPTERS)
