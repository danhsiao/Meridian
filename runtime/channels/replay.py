"""Replay payloads snapshotted to disk by `cli fetch`.

The fixtures do not change, extraction runs through a model, and fetching live
on every iteration makes it impossible to tell whether a result flipped because
a patch worked or because the far end returned something else.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..payload import Payload
from .base import Sent


class ReplayChannel:
    def __init__(self, fixtures_dir: str | Path, tool: str = "replay") -> None:
        self.tool = tool
        self.fixtures_dir = Path(fixtures_dir)
        self.sent: list[Sent] = []

    def fetch(self, match: Any = None, limit: int = 25) -> list[Payload]:
        if not self.fixtures_dir.exists():
            raise FileNotFoundError(
                f"no fixtures at {self.fixtures_dir}. Run `cli fetch --process <id> --live` first."
            )
        files = sorted(self.fixtures_dir.glob("*.json"))
        return [Payload.from_dict(json.loads(f.read_text())) for f in files[:limit]]

    def send(self, request: dict[str, Any]) -> Sent:
        record = Sent(tool=self.tool, request=dict(request), delivered=False)
        self.sent.append(record)
        return record
