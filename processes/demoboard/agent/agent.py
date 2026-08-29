"""GENERATED from a frozen spec. Do not hand-edit for a passing test.

    process:   demoboard
    spec_hash: sha256:4bf2e2870a8ecf7cf5fb731fd0072cc8055a097f574704f3509ce136a8603e8c
    topo:      ['cha_1', 'art_1', 'art_2', 'art_3', 'art_4', 'art_5', 'pol_1', 'pol_2', 'out_1']

Regenerate with `cli gen --process demoboard`.

This module is orchestration: one step per entry in `compiled.topo_order`, in
order, calling verbs that live in `runtime/`. It defines no logic of its own --
`cli/verify_generated.py` asserts that any function it does define is
byte-identical to an `impl.body` in the spec.

`payloads` is an override, not the source. Pass None -- as `cli run` does -- and
the channel node connects through its own `tool` and fetches. `cli eval` passes
one labelled case's payloads so the suite can score a case at a time.
"""
from __future__ import annotations

from typing import Any

from runtime import channels, outputs, relations
from runtime.extract import extract, scope_hint
from runtime.guards import on_absent, subsumes_guard
from runtime.identity import merge_by_identity_key
from runtime.helpers import squash
from runtime.payload import Payload
from runtime.spec import Spec
from runtime.state import RunState




def run(payloads: list[dict[str, Any]] | None = None, spec_path: str = "") -> dict[str, Any]:
    spec = Spec.load(spec_path)
    state = RunState()
    items: list[Payload] = []
    payload_of: dict[str, Payload] = {}

    # ── cha_1 (channel in, tool=composio.gmail) ──────────────────────────
    # The integration lives here, in the agent, because the board drew this node
    # and `topo_order` names it. `given=payloads` is the eval harness's override
    # -- one labelled case's payloads -- and is None on a live run, where the
    # agent resolves composio.gmail from the spec and fetches for itself.
    items += channels.inbound(spec, "cha_1", given=payloads)
    payload_of.update({p.id: p for p in items})

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
    # HEAL PASS 1 -- extraction-failure on art_2, two symptoms, one cause.
    # The spec's source_hint keys on PDFs *named* CoA. In six of eleven labelled
    # cases nothing matched and art_2 came back empty while art_4 held 7/3/6/12/
    # 9/14 batches; in two more it matched but the identifier lost its trailing
    # letter ('UCB26009' against art_4's 'UCB26009A'), so pol_2's join missed
    # every certificate. The hint widens the source to certificates carried
    # inside combined documents and pins the identifier to its printed form.
    # pol_2's relation and its `squash` comparison are untouched -- the fix is
    # in what gets read, not in what counts as a match.
    #
    # Re-applied by hand after the regeneration that moved the Composio
    # integration into the channel node. `cli gen` overwrites this file, so a
    # heal pass does not survive one; the log at ../heal-log.md is the record.
    _COA_HINT = (
        "Certificates of analysis. A certificate may be a standalone PDF or carried "
        "inside a combined document -- COC, 'COC & USDA', 'COC&COA', 'Final FP COA', "
        "'Uncontrolled COA'. Emit one row per certificate. Copy 'Batch No' exactly as "
        "printed, including any trailing letter suffix: 'UCB26009A', not 'UCB26009'."
    )
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
                extraction_hint=_COA_HINT,
                parent_id=_parent.record_id if _parent else None,
            ))

    # ── art_2 (merge duplicates on Batch No) ───────────────
    # The same record can arrive twice -- two forwards of one message, a resend.
    # `compiled.identity_merges` names the value that says two of them are the
    # same one. Last-write-wins on a field collision, union on an absent one;
    # the rule lives in runtime/identity.py and is not restated here.
    state.replace("art_2", merge_by_identity_key(state.records("art_2"), "Batch No"))

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

    # ── art_3 (merge duplicates on Invoice No) ───────────────
    # The same record can arrive twice -- two forwards of one message, a resend.
    # `compiled.identity_merges` names the value that says two of them are the
    # same one. Last-write-wins on a field collision, union on an absent one;
    # the rule lives in runtime/identity.py and is not restated here.
    state.replace("art_3", merge_by_identity_key(state.records("art_3"), "Invoice No"))

    # ── art_4 (artifact, inside art_3) ─────────────────────
    # Nested a level deeper, so the extraction has to say which parent it
    # belongs to or it returns every row in the payload for every parent.
    _config = spec.config("art_4")
    for _parent in state.records("art_3"):
        state.add("art_4", extract(
            payload_of[_parent.source],
            node_id="art_4", label=spec.label("art_4"),
            fields=_config.get("fields"), source_hint=_config.get("source_hint"),
            extraction_hint=scope_hint("Invoices", _parent.fields),
            parent_id=_parent.record_id,
        ))

    # ── art_4 (merge duplicates on Batch No) ───────────────
    # The same record can arrive twice -- two forwards of one message, a resend.
    # `compiled.identity_merges` names the value that says two of them are the
    # same one. Last-write-wins on a field collision, union on an absent one;
    # the rule lives in runtime/identity.py and is not restated here.
    state.replace("art_4", merge_by_identity_key(state.records("art_4"), "Batch No"))

    # ── art_5 (artifact, inside art_3) ─────────────────────
    # Nested a level deeper, so the extraction has to say which parent it
    # belongs to or it returns every row in the payload for every parent.
    _config = spec.config("art_5")
    for _parent in state.records("art_3"):
        state.add("art_5", extract(
            payload_of[_parent.source],
            node_id="art_5", label=spec.label("art_5"),
            fields=_config.get("fields"), source_hint=_config.get("source_hint"),
            extraction_hint=scope_hint("Invoices", _parent.fields),
            parent_id=_parent.record_id,
        ))

    # ── pol_1 (policy: present, verdict on art_5) ─────────────
    _config = spec.config("pol_1")
    _relation = _config["check"]["relation"]
    for _record in state.records("art_5"):
        _values = [state.field(_record, _path) for _path in _config["reads"]]
        _ok = None if subsumes_guard(_relation) else on_absent(_values, _config["on_absent"])
        if _ok is None:
            _ok = relations.present(_values)
        state.verdict("pol_1", "art_5", _record, _ok, f"present over {_config['reads']}")

    # ── pol_2 (policy: exists_matching, verdict on art_2) ─────
    _config = spec.config("pol_2")
    _subject_path, _candidate_path = _config["reads"]
    _candidates = state.values(_candidate_path)
    for _record in state.records("art_2"):
        _subject = state.field(_record, _subject_path)
        _ok = on_absent([_subject], _config["on_absent"])
        if _ok is None:
            # `squash` rather than exact equality: the two sides are transcribed
            # from different documents. The comparison is passed into the
            # relation, so the engine's definition of a match is untouched.
            _ok = relations.exists_matching(_subject, _candidates, key=squash)
        state.verdict("pol_2", "art_2", _record, _ok, f"exists_matching on {_candidate_path}")

    # ── e_7 (art_5 -> art_3, verdicts travel up) ───────
    # Emitted after every policy and before the outputs: propagation reads
    # verdicts, so every check has to have run first.
    state.propagate("art_5", "art_3")

    # ── out_1 (output) ─────────────────────────────────────────────
    # Bound to a name rather than computed in the return, because an outbound
    # channel later in `topo_order` sends exactly these rows.
    _outputs = outputs.rows(state, spec.config("out_1").get("rows", []))

    return {
        "outputs": _outputs,
        "extracted_state": state.extracted(),
    }
