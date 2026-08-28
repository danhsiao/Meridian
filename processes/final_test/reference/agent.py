"""Reference agent for `final_test` -- HAND-WRITTEN, not generated.

Written before codegen existed, and kept afterwards. It earns its place twice:

1. It proved the runtime API can express this process. A step needing something
   `runtime/` did not offer was a gap found by a human in minutes, rather than
   discovered through an LLM three hours later.
2. It is codegen's known-good target. When a generated agent fails an eval, the
   diff against this file says immediately whether the bug is in codegen or in
   the runtime -- without it, block 8 debugs two unproven layers at once.

Deliberately written the way the templates emit: one step per entry in
`compiled.topo_order`, in order, no reordering and no inferred dependencies.
Everything domain-specific is read out of the spec at run time; the only reason
this file lives under `processes/` is that it names node ids, and node ids are
this process's vocabulary.

Run it with `cli eval --process final_test --agent reference`.
"""
from __future__ import annotations

from typing import Any

from runtime import outputs, relations
from runtime.extract import extract, scope_hint
from runtime.guards import on_absent, subsumes_guard
from runtime.helpers import squash
from runtime.payload import Payload
from runtime.spec import Spec
from runtime.state import RunState


def run(payloads: list[dict[str, Any]], spec_path: str) -> dict[str, Any]:
    spec = Spec.load(spec_path)
    state = RunState()
    items = [Payload.from_dict(p) if isinstance(p, dict) else p for p in payloads]
    payload_of = {p.id: p for p in items}

    # ── cha_1 (channel) ──────────────────────────────────────────────────
    # Payloads arrive already fetched: the caller decides live or replay, so the
    # same agent serves a demo run and a deterministic eval.

    # ── art_1 (artifact, no fields) ──────────────────────────────────────
    # Holds child records and declares no values of its own, so each payload
    # becomes exactly one pass-through record.
    for item in items:
        state.add("art_1", extract(item, node_id="art_1", label=spec.label("art_1"),
                                   fields=spec.config("art_1").get("fields")))

    # ── art_2 (artifact, contained in art_1, many) ───────────────────────
    config = spec.config("art_2")
    for parent in state.records("art_1"):
        state.add("art_2", extract(
            payload_of[parent.source],
            node_id="art_2", label=spec.label("art_2"),
            fields=config.get("fields"), source_hint=config.get("source_hint"),
            extraction_hint=config.get("extraction_hint"), parent_id=parent.record_id,
        ))

    # ── art_3 (artifact, contained in art_1, many) ───────────────────────
    config = spec.config("art_3")
    for parent in state.records("art_1"):
        state.add("art_3", extract(
            payload_of[parent.source],
            node_id="art_3", label=spec.label("art_3"),
            fields=config.get("fields"), source_hint=config.get("source_hint"),
            extraction_hint=config.get("extraction_hint"), parent_id=parent.record_id,
        ))

    # ── art_4 (artifact, contained in art_2, many) ───────────────────────
    # Nested one level deeper, so the extraction has to say which art_2 it
    # belongs to or it returns every row in the payload for every parent.
    config = spec.config("art_4")
    for parent in state.records("art_2"):
        state.add("art_4", extract(
            payload_of[parent.source],
            node_id="art_4", label=spec.label("art_4"),
            fields=config.get("fields"), source_hint=config.get("source_hint"),
            extraction_hint=scope_hint(spec.label("art_2"), parent.fields),
            parent_id=parent.record_id,
        ))

    # ── pol_1 (policy: present, verdict on art_4) ────────────────────────
    config = spec.config("pol_1")
    relation = config["check"]["relation"]
    for record in state.records("art_4"):
        values = [state.field(record, path) for path in config["reads"]]
        ok = None if subsumes_guard(relation) else on_absent(values, config["on_absent"])
        if ok is None:
            ok = relations.present(values)
        state.verdict("pol_1", "art_4", record, ok, f"present over {config['reads']}")

    # ── pol_2 (policy: exists_matching, verdict on art_2) ────────────────
    config = spec.config("pol_2")
    subject_path, candidate_path = config["reads"]
    candidates = state.values(candidate_path)
    for record in state.records("art_2"):
        subject = state.field(record, subject_path)
        ok = on_absent([subject], config["on_absent"])
        if ok is None:
            # HEAL PASS 1 (logic-failure). The subject field can hold several
            # values in one string -- the board models this as a field on the
            # parent rather than as its own artifact, so a one-to-many arrives
            # comma-joined. Comparing the joined string against a single
            # candidate never matches. Split, and require every part to match.
            #
            # `squash` rather than exact equality: the two sides are transcribed
            # from different documents by different people. Both the split and
            # the comparison are passed into the relation as data, so the
            # engine's own definition of a match is untouched.
            parts = [p for p in str(subject).split(",") if p.strip()]
            ok = all(relations.exists_matching(p, candidates, key=squash) for p in parts)
        state.verdict("pol_2", "art_2", record, ok, f"exists_matching on {candidate_path}")

    # ── out_1 (output) ───────────────────────────────────────────────────
    return {
        "outputs": outputs.rows(state, spec.config("out_1").get("rows", [])),
        "extracted_state": state.extracted(),
    }
