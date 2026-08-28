"""The allow-list an `impl` body may call.

This module is a security boundary, not a convenience shelf. The AST validator
in `validate_impl.py` resolves every call in a generated body against `EXPORTS`;
anything not named here fails the gate and the body never reaches the spec.

Adding a helper is deliberate: it widens what a review-time model is allowed to
write. Keep them small, total, and free of I/O.
"""
from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any

_DATE_FORMATS = (
    "%Y-%m-%d",
    "%d-%b-%y",
    "%d-%b-%Y",
    "%d/%m/%Y",
    "%m/%d/%Y",
    "%d.%m.%Y",
    "%Y/%m/%d",
)


def normalize(value: Any) -> str:
    """Casefold, strip, and collapse internal whitespace."""
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip().casefold()


def squash(value: Any) -> str:
    """Like `normalize`, but drops whitespace and punctuation entirely.

    The comparison of last resort: it makes "AALC 25063A " and "AALC25063A" the
    same string. Deliberately not the default -- a verb that silently ignores
    formatting hides a real extraction bug behind a green test.
    """
    if value is None:
        return ""
    return re.sub(r"[^0-9a-z]", "", str(value).casefold())


def is_blank(value: Any) -> bool:
    """Empty by the engine's definition: None, empty string, or whitespace."""
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, (list, tuple, dict, set)):
        return len(value) == 0
    return False


def to_date(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def days_between(earlier: Any, later: Any) -> int | None:
    a, b = to_date(earlier), to_date(later)
    if a is None or b is None:
        return None
    return (b - a).days


def to_number(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    text = re.sub(r"[^0-9.\-]", "", str(value))
    if text in ("", "-", ".", "-."):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def lower(value: Any) -> str:
    return "" if value is None else str(value).lower()


def contains_text(haystack: Any, needle: Any) -> bool:
    return normalize(needle) in normalize(haystack)


#: The names an `impl` body may call. `validate_impl` reads this and nothing else,
#: so the allow-list cannot drift from the module.
EXPORTS: dict[str, Any] = {
    "normalize": normalize,
    "squash": squash,
    "is_blank": is_blank,
    "to_date": to_date,
    "days_between": days_between,
    "to_number": to_number,
    "lower": lower,
    "contains_text": contains_text,
    # Builtins a total predicate legitimately needs. Everything else -- open,
    # eval, __import__, getattr -- is absent, which is the point.
    "len": len,
    "abs": abs,
    "min": min,
    "max": max,
    "sum": sum,
    "all": all,
    "any": any,
    "str": str,
    "int": int,
    "float": float,
    "bool": bool,
    "sorted": sorted,
    "set": set,
    "list": list,
}
