"""RunState -- everything one execution knows.

Records are keyed by node_id; verdicts by (node_id, record_id). That pairing is
what makes `verdict_on` meaningful: a policy reading two artifacts still lands
its pass/fail on exactly one of them, named in the spec and resolved at freeze.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator

from .payload import Record


@dataclass
class Verdict:
    ok: bool
    node_id: str
    record_id: str
    policy_id: str
    detail: str = ""


def split_path(path: str) -> tuple[str, str]:
    """"a2.some field" -> ("a2", "some field").

    Split on the first dot only: field names are the operator's own words and
    routinely carry spaces, and nothing stops one carrying a dot.
    """
    node_id, _, field_name = path.partition(".")
    if not field_name:
        raise ValueError(f"not a field path: {path!r}")
    return node_id, field_name


class RunState:
    def __init__(self) -> None:
        self._records: dict[str, list[Record]] = {}
        self._verdicts: dict[tuple[str, str], Verdict] = {}
        self._notes: list[str] = []

    # ── records ──────────────────────────────────────────────────────────
    def add(self, node_id: str, records: Iterable[Record]) -> list[Record]:
        bucket = self._records.setdefault(node_id, [])
        added = list(records)
        bucket.extend(added)
        return added

    def records(self, node_id: str) -> list[Record]:
        return list(self._records.get(node_id, []))

    def node_ids(self) -> list[str]:
        return list(self._records.keys())

    def children(self, node_id: str, parent: Record) -> list[Record]:
        """Records of `node_id` produced under `parent`."""
        return [r for r in self._records.get(node_id, []) if r.parent_id == parent.record_id]

    def values(self, path: str) -> list[Any]:
        """Every value of one field across every record of its node."""
        node_id, field_name = split_path(path)
        return [r.get(field_name) for r in self._records.get(node_id, [])]

    def field(self, record: Record, path: str) -> Any:
        """Read one field of one record, tolerating a fully-qualified path."""
        _, field_name = split_path(path) if "." in path else ("", path)
        return record.get(field_name)

    # ── verdicts ─────────────────────────────────────────────────────────
    def verdict(self, policy_id: str, node_id: str, record: Record, ok: bool, detail: str = "") -> bool:
        """Record one pass/fail against one record.

        A record already failing stays failed: several policies can land on the
        same artifact, and one failure is enough. Without this, policy order
        would silently decide the answer.
        """
        key = (node_id, record.record_id)
        existing = self._verdicts.get(key)
        if existing is not None and not existing.ok:
            return existing.ok
        self._verdicts[key] = Verdict(
            ok=ok, node_id=node_id, record_id=record.record_id, policy_id=policy_id, detail=detail
        )
        return ok

    def verdict_of(self, node_id: str, record: Record) -> Verdict | None:
        return self._verdicts.get((node_id, record.record_id))

    def judged(self, node_id: str) -> list[Record]:
        return [r for r in self.records(node_id) if (node_id, r.record_id) in self._verdicts]

    def failed(self, node_id: str) -> list[Record]:
        return [r for r in self.records(node_id) if (v := self.verdict_of(node_id, r)) and not v.ok]

    def passed(self, node_id: str) -> list[Record]:
        return [r for r in self.records(node_id) if (v := self.verdict_of(node_id, r)) and v.ok]

    def select(self, node_id: str, where: str | None) -> list[Record]:
        if where == "fail":
            return self.failed(node_id)
        if where == "pass":
            return self.passed(node_id)
        return self.records(node_id)

    # ── reporting ────────────────────────────────────────────────────────
    def note(self, text: str) -> None:
        self._notes.append(text)

    def extracted(self) -> dict[str, Any]:
        """What the agent actually pulled.

        The eval report prints this beside expected-vs-actual, because a count
        mismatch says something is wrong and a trailing space says what.
        """
        return {
            "records": {
                node_id: [r.to_dict() for r in rows] for node_id, rows in self._records.items()
            },
            "verdicts": [
                {
                    "node_id": v.node_id,
                    "record_id": v.record_id,
                    "policy_id": v.policy_id,
                    "ok": v.ok,
                    "detail": v.detail,
                }
                for v in self._verdicts.values()
            ],
            "notes": list(self._notes),
        }

    def __iter__(self) -> Iterator[str]:
        return iter(self._records)
