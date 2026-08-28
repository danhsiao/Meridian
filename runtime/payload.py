"""What a channel hands back, and what an artifact is extracted into.

Both shapes are deliberately transport-agnostic. A mail message with three
attachments and an HTTP response with a JSON body are the same `Payload`: some
metadata, some text, and zero or more named parts.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Part:
    """One named piece hanging off a payload -- an attachment, a body section."""

    name: str
    mimetype: str = "text/plain"
    text: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "mimetype": self.mimetype, "text": self.text}

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "Part":
        return Part(name=d["name"], mimetype=d.get("mimetype", "text/plain"), text=d.get("text", ""))


@dataclass
class Payload:
    """One unit pulled from a channel."""

    id: str
    meta: dict[str, Any] = field(default_factory=dict)
    text: str = ""
    parts: list[Part] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "meta": self.meta,
            "text": self.text,
            "parts": [p.to_dict() for p in self.parts],
        }

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "Payload":
        return Payload(
            id=d["id"],
            meta=d.get("meta", {}),
            text=d.get("text", ""),
            parts=[Part.from_dict(p) for p in d.get("parts", [])],
        )


@dataclass
class Record:
    """One extracted row, owned by the artifact node that produced it.

    `record_id` is derived from content rather than assigned, so the same record
    extracted twice keys to the same verdict slot.
    """

    node_id: str
    record_id: str
    fields: dict[str, Any] = field(default_factory=dict)
    source: str = ""
    parent_id: str | None = None

    def get(self, name: str) -> Any:
        return self.fields.get(name)

    def to_dict(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "record_id": self.record_id,
            "fields": self.fields,
            "source": self.source,
            "parent_id": self.parent_id,
        }


def record_id_for(node_id: str, fields: dict[str, Any], parent_id: str | None, ordinal: int) -> str:
    """Content-addressed record id.

    `ordinal` is in the hash because two genuinely identical rows under the same
    parent are two records, not one -- deduplication is `identity_key`'s job and
    it runs later, where the rule is written down.
    """
    blob = json.dumps(
        {"n": node_id, "f": fields, "p": parent_id, "i": ordinal}, sort_keys=True, default=str
    )
    return f"{node_id}:{hashlib.sha256(blob.encode()).hexdigest()[:12]}"
