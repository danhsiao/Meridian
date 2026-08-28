"""The relation set.

Four relations ship. Each takes its subject as data -- there is no
`check_required_codes()` here and there never will be, because a verb named for
one process's rule is that process leaking into the engine.

Every relation is total: it returns a bool for any input, including empty ones.
Emptiness policy lives in `guards.py`, applied identically ahead of a relation
and ahead of an `impl` body, so the two shapes differ only in what runs after.

Deliberately absent: absent, in_set, within, older_than, newer_than,
less_than. They are a coverage cut, not a design limit -- each is one function
and one template, and the `impl` path means a policy fitting none of them still
compiles rather than blocking on relation five.
"""
from __future__ import annotations

from typing import Any, Callable, Iterable

from .helpers import is_blank, to_number


def present(values: Iterable[Any]) -> bool:
    """Every value the policy reads carries something."""
    return all(not is_blank(v) for v in values)


def equals(left: Any, right: Any) -> bool:
    """Two values are the same.

    Numeric when both sides parse as numbers, textual otherwise -- so "1,200.00"
    equals "1200" without the caller choosing a comparison up front.
    """
    ln, rn = to_number(left), to_number(right)
    if ln is not None and rn is not None:
        return ln == rn
    return str(left).strip() == str(right).strip()


def greater_than(left: Any, right: Any) -> bool:
    ln, rn = to_number(left), to_number(right)
    if ln is None or rn is None:
        return False
    return ln > rn


def exists_matching(subject: Any, candidates: Iterable[Any], key: Callable[[Any], Any] | None = None) -> bool:
    """Some candidate value matches the subject value.

    `key` is how the caller decides what "matches" means -- identity by default,
    `helpers.squash` when the two sides are formatted differently. Passing the
    comparison in rather than hardcoding it is what lets the heal loop fix a
    formatting mismatch inside the generated agent without touching this file.
    """
    k = key or (lambda v: v)
    if is_blank(subject):
        return False
    target = k(subject)
    return any(not is_blank(c) and k(c) == target for c in candidates)


#: `check.relation` -> function. Codegen looks the template up by this name; the
#: registry's enum and this table extend together or not at all.
RELATIONS: dict[str, Callable[..., bool]] = {
    "present": present,
    "equals": equals,
    "greater_than": greater_than,
    "exists_matching": exists_matching,
}
