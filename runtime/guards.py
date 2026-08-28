"""The `on_absent` guard.

Runs identically ahead of a relation and ahead of an `impl` body. Returns the
verdict when the guard decides, or None when it declines and the check should
run.

One exception, and it is stated in the plan rather than discovered here:
`present` and `absent` are *about* emptiness, so the guard would pre-empt the
relation it is guarding. For those the relation subsumes the guard and
`subsumes_guard` says so.
"""
from __future__ import annotations

from typing import Any, Iterable

from .helpers import is_blank

#: Relations whose whole subject is emptiness. The guard stands down for these.
SUBSUMES_GUARD = frozenset({"present", "absent"})


def subsumes_guard(relation: str | None) -> bool:
    return relation in SUBSUMES_GUARD


def on_absent(values: Iterable[Any], policy: str) -> bool | None:
    """`policy` is the spec's `on_absent`: "pass" or "fail".

    Returns True/False when any read value is empty, None when all are present
    and the check itself should decide.
    """
    if policy not in ("pass", "fail"):
        raise ValueError(f"on_absent must be 'pass' or 'fail', got {policy!r}")
    if any(is_blank(v) for v in values):
        return policy == "pass"
    return None
