"""GENERATED from a frozen spec. Do not hand-edit for a passing test.

    process:   demo_test
    spec_hash: sha256:54155f0cc107d62b212767693550092e55cd4ac47b69b91139195a40c158e258
    topo:      ['cha_1', 'art_1', 'art_2', 'art_4', 'art_3', 'art_5', 'pol_1', 'pol_2', 'out_1']

Regenerate with `cli gen --process demo_test`.

This module is orchestration: one step per entry in `compiled.topo_order`, in
order, calling verbs that live in `runtime/`. It defines no logic of its own --
`cli/verify_generated.py` asserts that any function it does define is
byte-identical to an `impl.body` in the spec.
"""
from __future__ import annotations

from typing import Any

from runtime import outputs, relations
from runtime.extract import extract, scope_hint
from runtime.guards import on_absent, subsumes_guard
from runtime.identity import merge_by_identity_key
from runtime.helpers import squash
from runtime.payload import Payload
from runtime.spec import Spec
from runtime.state import RunState


def run(payloads: list[dict[str, Any]], spec_path: str) -> dict[str, Any]:
    spec = Spec.load(spec_path)
    state = RunState()
    items = [Payload.from_dict(p) if isinstance(p, dict) else p for p in payloads]
    payload_of = {p.id: p for p in items}

    # ── cha_1 (channel, tool=composio.gmail) ─────────────────────────────
    # Payloads arrive already fetched: the caller decides live or replay, so the
    # same agent serves a demo run and a deterministic eval.

    # ── art_1 (artifact, from the payload) ─────────────────────────
    _config = spec.config("art_1")
    _parent_id = "cha_1"
    if _parent_id and spec.primitive(_parent_id) == "artifact":
        _parents = state.records(_parent_id)
    else:
        _parents = [None]
    for _parent in _parents:
        for _item in ([payload_of[_parent.source]] if _parent else items):
            state.add("art_1", extract(
                _item,
                node_id="art_1", label=spec.label("art_1"),
                fields=_config.get("fields"), source_hint=_config.get("source_hint"),
                extraction_hint=_config.get("extraction_hint"),
                parent_id=_parent.record_id if _parent else None,
            ))

    # ── art_2 (artifact, from the payload) ─────────────────────────
    _config = spec.config("art_2")
    _parent_id = "art_1"
    if _parent_id and spec.primitive(_parent_id) == "artifact":
        _parents = state.records(_parent_id)
    else:
        _parents = [None]
    for _parent in _parents:
        for _item in ([payload_of[_parent.source]] if _parent else items):
            state.add("art_2", extract(
                _item,
                node_id="art_2", label=spec.label("art_2"),
                fields=_config.get("fields"), source_hint=_config.get("source_hint"),
                extraction_hint=_config.get("extraction_hint"),
                parent_id=_parent.record_id if _parent else None,
            ))

    # ── art_4 (artifact, inside art_2) ─────────────────────
    # Nested a level deeper, so the extraction has to say which parent it
    # belongs to or it returns every row in the payload for every parent.
    _config = spec.config("art_4")
    for _parent in state.records("art_2"):
        state.add("art_4", extract(
            payload_of[_parent.source],
            node_id="art_4", label=spec.label("art_4"),
            fields=_config.get("fields"), source_hint=_config.get("source_hint"),
            extraction_hint=scope_hint("Invoices", _parent.fields),
            parent_id=_parent.record_id,
        ))

    # ── art_3 (artifact, from the payload) ─────────────────────────
    _config = spec.config("art_3")
    _parent_id = "art_1"
    if _parent_id and spec.primitive(_parent_id) == "artifact":
        _parents = state.records(_parent_id)
    else:
        _parents = [None]
    for _parent in _parents:
        for _item in ([payload_of[_parent.source]] if _parent else items):
            state.add("art_3", extract(
                _item,
                node_id="art_3", label=spec.label("art_3"),
                fields=_config.get("fields"), source_hint=_config.get("source_hint"),
                extraction_hint=_config.get("extraction_hint"),
                parent_id=_parent.record_id if _parent else None,
            ))

    # ── art_3 (merge duplicates on Batch No) ───────────────
    # The same record can arrive twice -- two forwards of one message, a resend.
    # `compiled.identity_merges` names the value that says two of them are the
    # same one. Last-write-wins on a field collision, union on an absent one;
    # the rule lives in runtime/identity.py and is not restated here.
    state.replace("art_3", merge_by_identity_key(state.records("art_3"), "Batch No"))

    # ── art_5 (artifact, inside art_2) ─────────────────────
    # Nested a level deeper, so the extraction has to say which parent it
    # belongs to or it returns every row in the payload for every parent.
    _config = spec.config("art_5")
    for _parent in state.records("art_2"):
        state.add("art_5", extract(
            payload_of[_parent.source],
            node_id="art_5", label=spec.label("art_5"),
            fields=_config.get("fields"), source_hint=_config.get("source_hint"),
            extraction_hint=scope_hint("Invoices", _parent.fields),
            parent_id=_parent.record_id,
        ))

    # ── pol_1 (policy: exists_matching, verdict on art_4) ─────
    _config = spec.config("pol_1")
    _subject_path, _candidate_path = _config["reads"]
    _candidates = state.values(_candidate_path)
    for _record in state.records("art_4"):
        _subject = state.field(_record, _subject_path)
        _ok = on_absent([_subject], _config["on_absent"])
        if _ok is None:
            # `squash` rather than exact equality: the two sides are transcribed
            # from different documents. The comparison is passed into the
            # relation, so the engine's definition of a match is untouched.
            _ok = relations.exists_matching(_subject, _candidates, key=squash)
        state.verdict("pol_1", "art_4", _record, _ok, f"exists_matching on {_candidate_path}")

    # ── pol_2 (policy: present, verdict on art_5) ─────────────
    _config = spec.config("pol_2")
    _relation = _config["check"]["relation"]
    for _record in state.records("art_5"):
        _values = [state.field(_record, _path) for _path in _config["reads"]]
        _ok = None if subsumes_guard(_relation) else on_absent(_values, _config["on_absent"])
        if _ok is None:
            _ok = relations.present(_values)
        state.verdict("pol_2", "art_5", _record, _ok, f"present over {_config['reads']}")

    # ── e_5 (art_5 -> art_2, verdicts travel up) ───────
    # Emitted after every policy and before the outputs: propagation reads
    # verdicts, so every check has to have run first.
    state.propagate("art_5", "art_2")

    # ── out_1 (output) ─────────────────────────────────────────────
    OUTPUT_NODE = "out_1"
    return {
        "outputs": outputs.rows(state, spec.config(OUTPUT_NODE).get("rows", [])),
        "extracted_state": state.extracted(),
    }
