"""Wrap any adapter and record `send()` instead of delivering it.

Selected by run mode, never by the spec: the same frozen spec sends live in a
demo run and captures under `cli eval`. That matters twice over -- a heal loop
over failing fixtures would otherwise deliver dozens of real messages per run,
and a captured send is *testable*, because the rendered subject and body land on
disk where the suite can assert against them.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..payload import Payload
from .base import Channel, Sent


class CaptureChannel:
    def __init__(self, inner: Channel, capture_dir: str | Path) -> None:
        self.inner = inner
        self.capture_dir = Path(capture_dir)
        self.sent: list[Sent] = []

    def fetch(self, match: Any = None, limit: int = 25) -> list[Payload]:
        return self.inner.fetch(match, limit)

    def send(self, request: dict[str, Any]) -> Sent:
        record = Sent(
            tool=getattr(self.inner, "tool", "unknown"), request=dict(request), delivered=False
        )
        self.sent.append(record)
        self.capture_dir.mkdir(parents=True, exist_ok=True)
        path = self.capture_dir / f"send-{len(self.sent):03d}.json"
        path.write_text(json.dumps(record.to_dict(), indent=2, default=str))
        return record
