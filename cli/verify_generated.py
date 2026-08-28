"""An AST lint over generated code.

This is what makes "the skeleton is a runtime library; rewriting it to pass a
test is not a fix" mechanical rather than a rule someone has to remember. It
runs on every `cli gen`, and a failure means regenerate, not patch.

The interesting assertion is the third one. Generated code is orchestration --
it walks the topo order and calls verbs. The single exception is an `impl` body,
and the check on it is a string comparison rather than a judgment call: any
function the module defines must be byte-identical to an `impl.body` in the
spec. A model that paraphrased the body, re-indented it, or invented a helper
fails here, at generation time, before anything runs.
"""
from __future__ import annotations

import ast
from pathlib import Path

from runtime.helpers import EXPORTS
from runtime.outputs import FUNCTIONS
from runtime.relations import RELATIONS
from runtime.spec import Spec

#: Names that live in the runtime. Generated code calling one is correct;
#: generated code *defining* one has reimplemented a verb.
RUNTIME_VERBS = set(RELATIONS) | set(FUNCTIONS) | set(EXPORTS) | {
    "extract", "scope_hint", "on_absent", "subsumes_guard", "rows", "verdict",
}

ALLOWED_IMPORT_ROOTS = {"runtime", "__future__", "typing", "json", "datetime", "re", "pathlib"}


def _defined_functions(tree: ast.AST) -> list[ast.FunctionDef]:
    return [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)]


def _source_of(node: ast.AST, text: str) -> str:
    return ast.get_source_segment(text, node) or ""


def verify(path: Path, spec: Spec) -> list[str]:
    text = Path(path).read_text()
    findings: list[str] = []

    try:
        tree = ast.parse(text)
    except SyntaxError as exc:
        return [f"generated module does not parse: {exc}"]

    # 1. imports resolve only to runtime.* and a small stdlib set
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] not in ALLOWED_IMPORT_ROOTS:
                    findings.append(f"imports {alias.name!r}, which is not runtime or stdlib")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root and root not in ALLOWED_IMPORT_ROOTS:
                findings.append(f"imports from {node.module!r}, which is not runtime or stdlib")

    # 2/3. every function it defines is byte-identical to an impl.body
    bodies = spec.impl_bodies()
    for fn in _defined_functions(tree):
        if fn.name == "run":
            continue
        if fn.name in RUNTIME_VERBS:
            findings.append(
                f"defines {fn.name}(), which is a runtime verb. Call it, do not reimplement it."
            )
            continue
        source = _source_of(fn, text)
        if not any(source.strip() == body.strip() for body in bodies):
            findings.append(
                f"defines {fn.name}(), which is not byte-identical to any impl.body in the spec. "
                "The only logic allowed in generated code is a pasted impl."
            )

    # 4. every node in topo_order appears
    for node_id in spec.topo_order:
        if node_id not in text:
            findings.append(f"topo_order names {node_id}, which the module never mentions")

    # 5. every propagation the compiler resolved is actually emitted. A missing
    #    one is silent: the parents simply stay unjudged, and every "how many
    #    were clean" row returns zero on a board where nothing is wrong.
    for prop in spec.compiled.get("propagations", []):
        call = f'propagate("{prop["from"]}", "{prop["to"]}")'
        if call not in text:
            findings.append(
                f"compiled.propagations names {prop['from']} -> {prop['to']}, "
                f"which the module never propagates"
            )

    # 6. every fail handler has a signal handler
    for handler in spec.fail_handlers:
        signal = handler.get("signal", "")
        if signal and signal not in text:
            findings.append(f"fail_handlers names signal {signal!r}, which the module never handles")

    return findings
