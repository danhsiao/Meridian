"""GENERATED from a frozen spec. Do not hand-edit for a passing test.

    process:   different_use_case
    spec_hash: sha256:1203f48fde2f952b46422f1622a6c63e89cc2d3bad227cf80c1ec273d3c2ea89
    topo:      ['cha_3', 'art_1', 'art_2', 'pol_1', 'out_1', 'cha_2']

Regenerate with `cli gen --process different_use_case`.

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

    # ── cha_3 (channel in, tool=composio.gmail) ──────────────────────────
    # The integration lives here, in the agent, because the board drew this node
    # and `topo_order` names it. `given=payloads` is the eval harness's override
    # -- one labelled case's payloads -- and is None on a live run, where the
    # agent resolves composio.gmail from the spec and fetches for itself.
    items += channels.inbound(spec, "cha_3", given=payloads)
    payload_of.update({p.id: p for p in items})

    # ── art_1 (artifact, from the payload) ─────────────────────────
    _config = spec.config("art_1")
    _parent_id = "cha_3"
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
    _parent_id = "cha_3"
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

    # ── pol_1 (policy: equals, verdict on art_2) ────────
    _config = spec.config("pol_1")
    _left_path, _right_path = _config["reads"]
    for _record in state.records("art_2"):
        _left = state.field(_record, _left_path)
        _right = state.field(_record, _right_path)
        if _right is None:
            _right = next(iter(state.values(_right_path)), None)
        _ok = on_absent([_left, _right], _config["on_absent"])
        if _ok is None:
            _ok = relations.equals(_left, _right)
        state.verdict("pol_1", "art_2", _record, _ok, "equals")

    # ── out_1 (output) ─────────────────────────────────────────────
    # Bound to a name rather than computed in the return, because an outbound
    # channel later in `topo_order` sends exactly these rows.
    _outputs = outputs.rows(state, spec.config("out_1").get("rows", []))

    # ── cha_2 (channel out, tool=composio.gmail) ─────────────────────────
    # An outbound channel has no `match`: it delivers rather than reads. Whether
    # it leaves the machine is the run's decision, not the board's -- `outbound`
    # captures to disk unless CHANNEL_MODE is live -- so emit the call
    # unconditionally and never branch on the mode here.
    channels.outbound(spec, "cha_2", _outputs)
    return {
        "outputs": _outputs,
        "extracted_state": state.extracted(),
    }
