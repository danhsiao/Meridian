
---

## The templates — worked examples

These are the exact shapes to emit. They are not decoration: `verify_generated.py`
checks the properties they embody, so code that departs from them structurally will
usually fail the lint. Fill `{{placeholders}}` from the spec; change nothing else.

### Order of steps

One step per `topo_order` entry, in order. Then, between the last policy and the
output step, one `propagate` call per entry in `compiled.propagations` — those are
not nodes, so they do not appear in `topo_order`, and they are the one thing you
emit that the topo order does not name.

### `module` — The module shell

Emit this once. `{{steps}}` is where the per-node steps go.

```python
"""GENERATED from a frozen spec. Do not hand-edit for a passing test.

    process:   {{process_id}}
    spec_hash: {{spec_hash}}
    topo:      {{topo_order}}

Regenerate with `cli gen --process {{process_id}}`.

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
from runtime.helpers import squash
from runtime.payload import Payload
from runtime.spec import Spec
from runtime.state import RunState

{{assumptions}}


def run(payloads: list[dict[str, Any]], spec_path: str) -> dict[str, Any]:
    spec = Spec.load(spec_path)
    state = RunState()
    items = [Payload.from_dict(p) if isinstance(p, dict) else p for p in payloads]
    payload_of = {p.id: p for p in items}

{{steps}}
    return {
        "outputs": outputs.rows(state, spec.config(OUTPUT_NODE).get("rows", [])),
        "extracted_state": state.extracted(),
    }
```

### `channel` — channel

A channel node emits no code -- payloads arrive already fetched.

```python
    # ── {{node_id}} (channel, tool={{tool}}) ─────────────────────────────
    # Payloads arrive already fetched: the caller decides live or replay, so the
    # same agent serves a demo run and a deterministic eval.
```

### `artifact_from_payload` — artifact, extracted from the payload

Use when the node has no parent, its parent is a channel, **or its parent carries no `fields`**. A fieldless parent is a pass-through envelope with nothing to narrow an extraction by.

```python
    # ── {{node_id}} (artifact, from the payload) ─────────────────────────
    _config = spec.config("{{node_id}}")
    _parent_id = {{parent_id}}
    if _parent_id and spec.primitive(_parent_id) == "artifact":
        _parents = state.records(_parent_id)
    else:
        _parents = [None]
    for _parent in _parents:
        for _item in ([payload_of[_parent.source]] if _parent else items):
            state.add("{{node_id}}", extract(
                _item,
                node_id="{{node_id}}", label=spec.label("{{node_id}}"),
                fields=_config.get("fields"), source_hint=_config.get("source_hint"),
                extraction_hint=_config.get("extraction_hint"),
                parent_id=_parent.record_id if _parent else None,
            ))
```

### `artifact_nested` — artifact, extracted inside a parent that has fields

Use only when the parent carries `fields`. The `scope_hint` is what stops the model returning every row in the payload for every parent.

```python
    # ── {{node_id}} (artifact, inside {{parent_id}}) ─────────────────────
    # Nested a level deeper, so the extraction has to say which parent it
    # belongs to or it returns every row in the payload for every parent.
    _config = spec.config("{{node_id}}")
    for _parent in state.records({{parent_id}}):
        state.add("{{node_id}}", extract(
            payload_of[_parent.source],
            node_id="{{node_id}}", label=spec.label("{{node_id}}"),
            fields=_config.get("fields"), source_hint=_config.get("source_hint"),
            extraction_hint=scope_hint({{parent_label}}, _parent.fields),
            parent_id=_parent.record_id,
        ))
```

### `policy_present` — policy, `check.relation == "present"`

Note the guard: `subsumes_guard` stands `on_absent` down, because `present` is itself about emptiness.

```python
    # ── {{node_id}} (policy: present, verdict on {{target}}) ─────────────
    _config = spec.config("{{node_id}}")
    _relation = _config["check"]["relation"]
    for _record in state.records({{target}}):
        _values = [state.field(_record, _path) for _path in _config["reads"]]
        _ok = None if subsumes_guard(_relation) else on_absent(_values, _config["on_absent"])
        if _ok is None:
            _ok = relations.present(_values)
        state.verdict("{{node_id}}", {{target}}, _record, _ok, f"present over {_config['reads']}")
```

### `policy_exists_matching` — policy, `check.relation == "exists_matching"`

`reads` supplies the operands positionally: first the subject, then the candidate pool.

```python
    # ── {{node_id}} (policy: exists_matching, verdict on {{target}}) ─────
    _config = spec.config("{{node_id}}")
    _subject_path, _candidate_path = _config["reads"]
    _candidates = state.values(_candidate_path)
    for _record in state.records({{target}}):
        _subject = state.field(_record, _subject_path)
        _ok = on_absent([_subject], _config["on_absent"])
        if _ok is None:
            # `squash` rather than exact equality: the two sides are transcribed
            # from different documents. The comparison is passed into the
            # relation, so the engine's definition of a match is untouched.
            _ok = relations.exists_matching(_subject, _candidates, key=squash)
        state.verdict("{{node_id}}", {{target}}, _record, _ok, f"exists_matching on {_candidate_path}")
```

### `policy_binary` — policy, `check.relation` in `equals` / `greater_than`

Two operands, both from `reads`.

```python
    # ── {{node_id}} (policy: {{relation}}, verdict on {{target}}) ────────
    _config = spec.config("{{node_id}}")
    _left_path, _right_path = _config["reads"]
    for _record in state.records({{target}}):
        _left = state.field(_record, _left_path)
        _right = state.field(_record, _right_path)
        if _right is None:
            _right = next(iter(state.values(_right_path)), None)
        _ok = on_absent([_left, _right], _config["on_absent"])
        if _ok is None:
            _ok = relations.{{relation}}(_left, _right)
        state.verdict("{{node_id}}", {{target}}, _record, _ok, "{{relation}}")
```

### `policy_impl` — policy with an `impl` rather than a `check`

`{{body}}` is pasted **verbatim** from `spec.nodes[id].config.impl.body`. Never reformat it.

```python
    # ── {{node_id}} (policy: impl, verdict on {{target}}) ────────────────
    # The body below is pasted verbatim from the frozen spec. It was written by
    # the review agent, passed the AST validator before the mutation was ever
    # written, and was confirmed by a human in their own field names.
    # verify_generated.py asserts it is byte-identical to the spec's impl.body.
{{body}}
    _config = spec.config("{{node_id}}")
    _signature = {{signature}}
    for _record in state.records({{target}}):
        _values = [state.field(_record, _path) for _path in _signature]
        _ok = on_absent(_values, _config["on_absent"])
        if _ok is None:
            _ok = bool(check(*_values))
        state.verdict("{{node_id}}", {{target}}, _record, _ok, "impl")
```

### `propagate` — one entry in `compiled.propagations`

**Placement matters and is not negotiable: after every policy step, before the output step.** Propagation reads verdicts, so every check has to have run first. Emit one call per entry in `compiled.propagations`, using its `from` (the child) and `to` (the parent) exactly as written -- the edge runs parent to child, and verdicts travel the other way, which the compiler has already resolved for you.

```python
    # ── {{edge_id}} ({{from_id}} -> {{to_id}}, verdicts travel up) ───────
    # Emitted after every policy and before the outputs: propagation reads
    # verdicts, so every check has to have run first.
    state.propagate("{{from_id}}", "{{to_id}}")
```

### `output` — output

Records the node id; `outputs.rows` does the work in the module shell.

```python
    # ── {{node_id}} (output) ─────────────────────────────────────────────
    OUTPUT_NODE = "{{node_id}}"
```
