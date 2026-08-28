"""The channel protocol. Two methods, and nothing else.

A channel is where things arrive and where things go. What it connects to, what
authentication it needs, and what a message looks like on the wire are the
adapter's business; the engine only ever sees `list[Payload]` and `Sent`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from ..payload import Payload


@dataclass
class Sent:
    """One outbound delivery, recorded whether or not it left the machine."""

    tool: str
    request: dict[str, Any]
    delivered: bool = False
    detail: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "tool": self.tool,
            "request": self.request,
            "delivered": self.delivered,
            "detail": self.detail,
        }


@runtime_checkable
class Channel(Protocol):
    def fetch(self, match: Any = None, limit: int = 25) -> list[Payload]: ...

    def send(self, request: dict[str, Any]) -> Sent: ...
