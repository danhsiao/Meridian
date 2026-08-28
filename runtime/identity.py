"""Merging records that are the same thing arriving twice.

The rule, written down because codegen cannot emit a merge until it is:
**last-write-wins on a field collision, union on an absent one.** The later
record's value replaces the earlier one where both carry something; where only
one carries a value, that value survives.
"""
from __future__ import annotations

from .helpers import is_blank
from .payload import Record


def merge_by_identity_key(records: list[Record], identity_key: str) -> list[Record]:
    merged: dict[object, Record] = {}
    order: list[object] = []
    for record in records:
        key = record.get(identity_key)
        if is_blank(key):
            # No key means nothing to merge on. Keeping it distinct is the safe
            # direction: collapsing keyless records would silently lose rows.
            merged[record.record_id] = record
            order.append(record.record_id)
            continue
        if key not in merged:
            merged[key] = record
            order.append(key)
            continue
        first = merged[key]
        for name, value in record.fields.items():
            if not is_blank(value):
                first.fields[name] = value
            elif name not in first.fields:
                first.fields[name] = value
    return [merged[k] for k in order]
