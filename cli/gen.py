"""`cli gen --process <id>` -- emit an agent from a frozen spec.

Deterministic by construction. The same spec produces byte-identical code, which
is what keeps `spec_hash` meaning something: a build ID that named a different
program each time it was cashed would not be a build ID.

That determinism is why the templating lives here rather than inside the skill.
`skills/spec-to-agent/SKILL.md` is the judgment layer -- it reads the spec, reads
the runtime surface, decides which template each node takes, and handles what
the templates do not cover. This module is the mechanical part it drives, and
splitting them that way means the part that must be reproducible has no model in
it at all.

**Generated code is orchestration only.** It walks `compiled.topo_order` and
calls runtime verbs. The single exception is an `impl` body, pasted verbatim from
the spec -- and `verify_generated.py` checks that byte-for-byte, so "rewriting
the skeleton is not a fix" is a check that runs rather than a policy anyone has
to remember.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from runtime.spec import Spec

from .paths import agent_dir, spec_path
from .verify_generated import verify

TEMPLATES = Path(__file__).resolve().parents[1] / "skills" / "spec-to-agent" / "templates"


def template(name: str) -> str:
    return (TEMPLATES / f"{name}.py.j2").read_text()


def fill(name: str, **values: Any) -> str:
    """Substitute `{{key}}` placeholders. No expressions, no logic in templates.

    A template language with control flow would let generation decide things that
    freeze already decided; keeping substitution this dumb is what forces every
    structural choice back into the compiled block where it belongs.
    """
    text = template(name)
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", str(value))
    return text


def _literal(value: Any) -> str:
    return json.dumps(value, sort_keys=True)


def emit_channel(spec: Spec, node_id: str) -> str:
    return fill("channel", node_id=node_id, tool=_literal(spec.config(node_id).get("tool")))


def emit_artifact(spec: Spec, node_id: str) -> str:
    parent = spec.parent_of(node_id)
    if parent is None or spec.primitive(parent) == "channel":
        return fill("artifact_from_payload", node_id=node_id, parent_id=_literal(parent or ""))
    return fill(
        "artifact_nested",
        node_id=node_id,
        parent_id=_literal(parent),
        parent_label=_literal(spec.label(parent)),
    )


def emit_policy(spec: Spec, node_id: str) -> str:
    config = spec.config(node_id)
    target = spec.verdict_targets.get(node_id)
    if target is None:
        raise SystemExit(
            f"{node_id} has no verdict target in compiled.verdict_targets. "
            "That is a freeze bug, not something generation may guess at."
        )

    if config.get("impl"):
        # The one legal way for logic to appear in generated code: pasted
        # verbatim, never paraphrased, never re-indented.
        impl = config["impl"]
        return fill(
            "policy_impl",
            node_id=node_id,
            target=_literal(target),
            body=impl["body"],
            signature=_literal(list(impl["signature"])),
        )

    relation = (config.get("check") or {}).get("relation")
    if relation == "exists_matching":
        return fill("policy_exists_matching", node_id=node_id, target=_literal(target))
    if relation in ("equals", "greater_than"):
        return fill("policy_binary", node_id=node_id, target=_literal(target), relation=relation)
    if relation == "present":
        return fill("policy_present", node_id=node_id, target=_literal(target))
    raise SystemExit(
        f"{node_id} names relation {relation!r}, which has no template. "
        f"Add one template and one function in runtime/relations.py, together."
    )


def emit_output(spec: Spec, node_id: str) -> str:
    return fill("output", node_id=node_id)


EMITTERS = {
    "channel": emit_channel,
    "artifact": emit_artifact,
    "policy": emit_policy,
    "output": emit_output,
}


def generate(spec: Spec) -> str:
    steps = []
    for node_id in spec.topo_order:
        primitive = spec.primitive(node_id)
        emitter = EMITTERS.get(primitive)
        if emitter is None:
            raise SystemExit(f"no emitter for primitive {primitive!r} ({node_id})")
        steps.append(emitter(spec, node_id))

    assumptions = "\n".join(
        f"# assumption {a['id']}: {a.get('text', '')}"
        for a in spec.data.get("provenance", {}).get("assumptions", [])
    )
    return fill(
        "module",
        process_id=spec.process_id,
        spec_hash=spec.spec_hash,
        topo_order=" -> ".join(spec.topo_order),
        assumptions=assumptions,
        steps="\n".join(steps),
    )


def gen(process_id: str, expect_hash: str | None = None) -> int:
    spec = Spec.load(spec_path(process_id))
    if expect_hash and expect_hash.split(":")[-1] not in spec.spec_hash:
        raise SystemExit(
            f"{process_id} on disk is {spec.spec_hash}, not {expect_hash}. "
            f"Run `cli pull --spec {expect_hash}` first."
        )

    if spec.fail_handlers:
        print(
            f"  note: {len(spec.fail_handlers)} fail handler(s) in the spec are not emitted. "
            "The fail edge is out of scope for this build."
        )

    out_dir = agent_dir(process_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "__init__.py").write_text("from .agent import run\n\n__all__ = [\"run\"]\n")
    target = out_dir / "agent.py"
    target.write_text(generate(spec))
    print(f"  emitted {target}")

    findings = verify(target, spec)
    if findings:
        print("\n  verify_generated: FAILED")
        for f in findings:
            print(f"    - {f}")
        print("\n  Regenerate; do not patch. The skeleton is a runtime library.")
        return 1
    print("  verify_generated: clean")
    return 0
