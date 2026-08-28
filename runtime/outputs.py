"""Output row functions.

One per `output.fn` registry enum value. Each honours `where: pass | fail`, so
"how many failed" and "how many there were" are the same verb with a filter
rather than two.
"""
from __future__ import annotations

from typing import Any

from .helpers import to_number
from .state import RunState, split_path


def count(state: RunState, of: str, where: str | None = None) -> int:
    node_id = of.split(".")[0]
    return len(state.select(node_id, where))


def sum_values(state: RunState, of: str, where: str | None = None) -> float:
    node_id, field_name = split_path(of)
    total = 0.0
    for record in state.select(node_id, where):
        n = to_number(record.get(field_name))
        if n is not None:
            total += n
    return total


def list_values(state: RunState, of: str, where: str | None = None) -> list[Any]:
    node_id, field_name = split_path(of)
    return [r.get(field_name) for r in state.select(node_id, where)]


def copy_value(state: RunState, of: str, where: str | None = None) -> Any:
    """Carry one value through to the report.

    Freeze rejects `copy` across a `many` edge, so by the time this runs there is
    at most one record to copy from; returning None for zero keeps the row shape
    stable rather than raising on an empty run.
    """
    values = list_values(state, of, where)
    return values[0] if values else None


def verdict(state: RunState, of: str, where: str | None = None) -> bool:
    """True when nothing under `of` failed."""
    node_id = of.split(".")[0]
    return len(state.failed(node_id)) == 0


FUNCTIONS = {
    "count": count,
    "sum": sum_values,
    "list": list_values,
    "copy": copy_value,
    "verdict": verdict,
}


def rows(state: RunState, row_specs: list[dict[str, Any]]) -> dict[str, Any]:
    """Evaluate an output node's rows into {label: value}.

    A row whose `of` names no node yields None rather than raising: freeze has
    already rejected an unresolvable row, so a None here means the spec was
    written by hand, and a readable report beats a stack trace.
    """
    out: dict[str, Any] = {}
    for row in row_specs:
        label = row.get("label", "")
        fn = FUNCTIONS.get(row.get("fn", ""))
        of = row.get("of")
        if fn is None or not of:
            out[label] = None
            continue
        out[label] = fn(state, of, row.get("where"))
    return out
