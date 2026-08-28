"""The gate on `impl` bodies.

A policy the operator describes usually resolves to one of the relations. When
none fits, the review agent writes the function instead -- and this is what
stands between that and a spec. It runs at review time, before the mutation is
ever written: reject, and the agent retries; the body never reaches the spec and
never reaches generated code.

The defence is not that the model is trustworthy. It is that an `impl` body gets
strictly *less* latitude than the codegen agent already has:

1. **Declared surface.** The agent emits `signature`, `reads_fields` and
   `helpers` alongside the body, as a contract rather than documentation.
   Self-declaration plus verification beats parsing the body alone.
2. **This validator.** No imports, no dunders, no attribute access, calls only
   into the helper allow-list, and `signature` must equal `reads` so the
   function cannot quietly widen what it looks at.
3. **Human sign-off.** `confirmed_by` points at a comment that stays open until
   the reading is confirmed in the operator's own field names, and an open
   comment already blocks freeze.

And it runs once, at review time, into an immutable artifact -- not per record at
execution.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass, field
from typing import Any, Callable

from .helpers import EXPORTS

#: Statement and expression types an `impl` body may not contain at all.
FORBIDDEN_NODES: dict[type, str] = {
    ast.Import: "import",
    ast.ImportFrom: "import",
    ast.Attribute: "attribute access",
    ast.Global: "global",
    ast.Nonlocal: "nonlocal",
    ast.With: "with",
    ast.AsyncWith: "async with",
    ast.Try: "try",
    ast.Raise: "raise",
    ast.Delete: "del",
    ast.ClassDef: "class definition",
    ast.AsyncFunctionDef: "async function",
    ast.Await: "await",
    ast.Yield: "yield",
    ast.YieldFrom: "yield from",
}

ENTRY_POINT = "check"


@dataclass
class Result:
    ok: bool
    errors: list[str] = field(default_factory=list)

    def __bool__(self) -> bool:
        return self.ok


def leaf(path: str) -> str:
    """"art_2.cleared_date" -> "cleared_date". The parameter name a body sees."""
    return path.partition(".")[2] or path


def validate(impl: dict[str, Any], reads: list[str] | None = None) -> Result:
    """Check one `impl` block against its declared surface.

    `reads` is the policy's own `reads` list. When supplied, `signature` must
    equal it -- that equality is what stops a body reading a field the review
    conversation never surfaced and the operator never signed off on.
    """
    errors: list[str] = []

    body = impl.get("body")
    signature = list(impl.get("signature") or [])
    declared_reads = list(impl.get("reads_fields") or [])
    declared_helpers = list(impl.get("helpers") or [])

    if not isinstance(body, str) or not body.strip():
        return Result(False, ["impl.body is missing or empty"])
    if not signature:
        errors.append("impl.signature is missing")

    # ── the declared surface must match the policy's own reads ───────────
    if reads is not None and sorted(signature) != sorted(reads):
        errors.append(
            f"impl.signature {sorted(signature)} does not equal reads {sorted(reads)}; "
            "a body may not widen or narrow what the policy looks at"
        )
    if sorted(declared_reads) != sorted(signature):
        errors.append(
            f"impl.reads_fields {sorted(declared_reads)} does not equal "
            f"impl.signature {sorted(signature)}"
        )

    unknown_helpers = [h for h in declared_helpers if h not in EXPORTS]
    if unknown_helpers:
        errors.append(
            f"impl.helpers names {unknown_helpers}, which runtime/helpers.py does not export"
        )

    # ── the body itself ──────────────────────────────────────────────────
    try:
        tree = ast.parse(body)
    except SyntaxError as exc:
        return Result(False, errors + [f"impl.body does not parse: {exc}"])

    functions = [n for n in tree.body if isinstance(n, ast.FunctionDef)]
    if len(tree.body) != len(functions) or len(functions) != 1:
        errors.append("impl.body must be exactly one function definition and nothing else")
    if functions and functions[0].name != ENTRY_POINT:
        errors.append(f"impl.body must define {ENTRY_POINT}(), not {functions[0].name}()")

    if functions:
        args = functions[0].args
        if args.vararg or args.kwarg or args.posonlyargs or args.kwonlyargs:
            errors.append("check() takes plain positional parameters only")
        params = [a.arg for a in args.args]
        expected = [leaf(s) for s in signature]
        if params != expected:
            errors.append(
                f"check({', '.join(params)}) does not match impl.signature; expected "
                f"check({', '.join(expected)})"
            )

    allowed_names = set(EXPORTS) | {leaf(s) for s in signature}

    for node in ast.walk(tree):
        for forbidden, why in FORBIDDEN_NODES.items():
            if isinstance(node, forbidden):
                errors.append(f"impl.body uses {why}, which is not allowed")
                break

        if isinstance(node, ast.Name) and node.id.startswith("__"):
            errors.append(f"impl.body touches the dunder name {node.id!r}")

        if isinstance(node, ast.Call):
            callee = node.func
            if not isinstance(callee, ast.Name):
                errors.append("impl.body calls something other than a plain helper name")
            elif callee.id not in EXPORTS:
                errors.append(
                    f"impl.body calls {callee.id!r}, which is not exported from runtime/helpers.py"
                )
            elif callee.id not in declared_helpers and callee.id not in _BUILTIN_EXPORTS:
                errors.append(
                    f"impl.body calls {callee.id!r} without declaring it in impl.helpers"
                )

        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            if node.id not in allowed_names and node.id not in _LOCALS(tree):
                errors.append(
                    f"impl.body reads {node.id!r}, which is neither a declared field nor a helper"
                )

    # de-duplicate while keeping the first occurrence's ordering
    seen, unique = set(), []
    for e in errors:
        if e not in seen:
            seen.add(e)
            unique.append(e)
    return Result(not unique, unique)


#: Names from EXPORTS that are ordinary builtins rather than engine helpers.
#: A body may call these without listing them, the way it may use `+`.
_BUILTIN_EXPORTS = frozenset(
    {"len", "abs", "min", "max", "sum", "all", "any", "str", "int", "float", "bool", "sorted", "set", "list"}
)


def _LOCALS(tree: ast.AST) -> set[str]:
    """Names the body binds itself -- assignments, loop targets, comprehensions."""
    bound: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            bound.add(node.id)
        elif isinstance(node, ast.arg):
            bound.add(node.arg)
    return bound


def compile_impl(impl: dict[str, Any], reads: list[str] | None = None) -> Callable[..., bool]:
    """Validate, then compile to a callable with no ambient namespace.

    `__builtins__` is emptied deliberately: the validator already rejects a body
    that reaches for one, and stripping it means a validator gap is a NameError
    at run time rather than a capability.
    """
    result = validate(impl, reads)
    if not result.ok:
        raise ValueError("impl rejected:\n" + "\n".join(f"  - {e}" for e in result.errors))
    namespace: dict[str, Any] = {"__builtins__": {}, **EXPORTS}
    exec(compile(impl["body"], "<impl>", "exec"), namespace)  # noqa: S102 - gated above
    return namespace[ENTRY_POINT]
