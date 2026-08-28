"""Extract the runtime's public API surface as text.

This is half of what the codegen skill is allowed to see. It is generated from
the modules themselves rather than hand-maintained, so the surface the model
reads cannot drift from the surface that exists -- a stale hand-written summary
would have the model emitting calls against an API that changed underneath it.

Signatures and docstrings only. No bodies: the model's job is to call these
verbs, and showing it an implementation invites it to inline one.
"""
from __future__ import annotations

import ast
import inspect
from pathlib import Path

RUNTIME = Path(__file__).resolve().parents[1] / "runtime"

#: The modules generated code is allowed to call into, in the order a reader
#: needs them.
MODULES = [
    "spec.py",
    "state.py",
    "payload.py",
    "extract.py",
    "relations.py",
    "guards.py",
    "outputs.py",
    "helpers.py",
    "identity.py",
]


def _first_line(node: ast.AST) -> str:
    doc = ast.get_docstring(node) or ""
    return doc.strip().split("\n")[0] if doc else ""


def _signature(node: ast.FunctionDef) -> str:
    return f"{node.name}({', '.join(a.arg for a in node.args.args)})"


def module_surface(path: Path) -> str:
    tree = ast.parse(path.read_text())
    lines = [f"### `runtime/{path.name}`", ""]
    header = ast.get_docstring(tree)
    if header:
        lines += [header.strip().split("\n\n")[0], ""]

    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            lines.append(f"- **class `{node.name}`** — {_first_line(node)}")
            for sub in node.body:
                if isinstance(sub, ast.FunctionDef) and not sub.name.startswith("_"):
                    lines.append(f"    - `{_signature(sub)}` — {_first_line(sub)}")
        elif isinstance(node, ast.FunctionDef) and not node.name.startswith("_"):
            lines.append(f"- `{_signature(node)}` — {_first_line(node)}")
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id.isupper():
                    lines.append(f"- `{target.id}` — module-level table")
    lines.append("")
    return "\n".join(lines)


def surface() -> str:
    parts = [
        "# The runtime API surface",
        "",
        "These are the only verbs generated code may call. Signatures and one-line",
        "descriptions only -- call them, never reimplement one.",
        "",
    ]
    for name in MODULES:
        path = RUNTIME / name
        if path.exists():
            parts.append(module_surface(path))
    return "\n".join(parts)
