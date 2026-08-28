---
name: spec-to-agent
description: Generate a runnable agent from a frozen spec. Use when a board has been frozen and needs code — invoked as `cli gen --process <id>`. Reads the frozen spec and the runtime API surface, emits processes/<id>/agent/, and runs the lint on its own output.
---

# spec-to-agent

Turn a frozen spec into a runnable agent.

## Your input is the frozen spec and nothing else

Not the project README. Not the domain framing. Not an example from the process
you are generating. If you find yourself needing to know what the business does
in order to emit correct code, **stop and say so** — that means the spec is
insufficient, and the spec being sufficient is precisely the property under test
here.

The worked example at the bottom of this file uses a synthetic spec (`a1`, `p1`,
`f1`) for the same reason. An example drawn from a real industry would pass the
noun lint if phrased carefully and still teach you that industry.

## What generation is, and what it is not

Two things happen when a board becomes code, and keeping them apart is the whole
design:

- **`cli gen` is deterministic template-filling.** Same spec in, byte-identical
  code out. That is what keeps `spec_hash` meaningful — a build ID that named a
  different program on each invocation would not be a build ID. There is no
  model in that path at all. The mechanism is `cli/gen.py` plus
  `templates/*.py.j2`, and the substitution is deliberately dumb: `{{key}}`
  replacement with no expressions and no control flow, so no structural decision
  can migrate out of the compiled block and into a template.

- **You are the judgment layer.** You read the spec, read the runtime surface,
  confirm each node maps to a template, run the generator, read the lint output,
  and handle what the templates do not cover. When a node needs a template that
  does not exist, you say which template and which runtime verb are missing —
  you do not improvise code into the output.

## Steps

1. **Read the frozen spec** at `processes/<id>/spec.json`. Read `compiled` in
   particular: `topo_order`, `loop_scopes`, `verdict_targets`, `joins`,
   `fail_handlers`.
2. **Read the runtime API surface** — `runtime/relations.py`,
   `runtime/outputs.py`, `runtime/state.py`, `runtime/extract.py`,
   `runtime/guards.py`. These are the only verbs generated code may call.
3. **Check every node has a template.** Each `policy` needs its
   `check.relation` (or its `impl`) to map to a file in `templates/`. Each
   `output.fn` needs an entry in `runtime/outputs.FUNCTIONS`. A gap here is a
   report, not an improvisation.
4. **Run `cli gen --process <id>`.**
5. **Read the `verify_generated` output.** If it fails, regenerate — do not
   patch. A generated module that was hand-edited to pass a lint is no longer
   traceable to a spec hash, which is the one property the whole pipeline sells.

## Rules

These are verbatim constraints, not guidance.

- **One step per `topo_order` entry, in order.** Never reorder, never infer a
  dependency, never skip a node.
- **Look up the template from the node's primitive and enum value; fill it from
  `node.config`.** The template set and the registry extend together or not at
  all.
- **Never ask whether an edge is a join. Never sort. Never work out nesting.**
  `edge_roles`, `joins`, `loop_scopes` and `verdict_targets` are already
  resolved. Re-deriving any of them at generation time means two components can
  disagree about the same graph, which is the failure class this design exists
  to prevent.
- **If the prompt or the generated code contains a rule, that rule is in the
  wrong place.** Rules live in the spec. Code walks the spec.
- **A node that looks unreachable, misordered or unbound is a freeze bug.** Halt
  and say so. Do not compensate.
- **`fail_handlers` may be empty.** When it is, emit no signal handlers and run
  straight to the output node. Do not invent a wait.
- **`policy_impl.py.j2` pastes `impl.body` verbatim** and calls
  `check(*values)`. Never paraphrase it, never re-indent it, never "clean it
  up". `verify_generated.py` compares it to the spec byte-for-byte and a
  cosmetic edit fails the build.

## Generated code is orchestration only

It walks the topo order and calls runtime verbs. It contains no presence check,
no counting loop, no comparison written out longhand — those are `relations.py`
and `outputs.py`, and reimplementing one inside generated code is caught by
`verify_generated.py` as a defined function matching a runtime verb name.

The single exception is a pasted `impl` body. That is the one legal way for
logic to appear, and it is checked as a string comparison rather than a
judgment call.

## Generate every frozen spec, not just the interesting one

Two agents emitted from the same templates and diffable side by side is the
strongest available evidence that this is an engine and not one process with
extra steps. It costs one extra command.

## Worked example — a synthetic spec

Given a spec whose compiled block reads:

```json
{ "topo_order": ["c1", "a1", "a2", "p1", "o1"],
  "loop_scopes": { "a2": ["e2"], "p1": ["e2"] },
  "verdict_targets": { "p1": "a2" } }
```

with `p1.check.relation = "present"` over `reads: ["a2.f1", "a2.f2"]`, the
emitted module is five steps in `topo_order` order:

```python
def run(payloads, spec_path):
    spec = Spec.load(spec_path)
    state = RunState()
    items = [Payload.from_dict(p) for p in payloads]
    payload_of = {p.id: p for p in items}

    # ── c1 (channel) ── payloads arrive already fetched

    # ── a1 (artifact, from the payload) ──
    ...state.add("a1", extract(_item, node_id="a1", ...))

    # ── a2 (artifact, inside a1) ──
    for _parent in state.records("a1"):
        state.add("a2", extract(payload_of[_parent.source], node_id="a2",
                                extraction_hint=scope_hint("Item", _parent.fields), ...))

    # ── p1 (policy: present, verdict on a2) ──
    for _record in state.records("a2"):
        _values = [state.field(_record, _path) for _path in _config["reads"]]
        _ok = None if subsumes_guard(_relation) else on_absent(_values, _config["on_absent"])
        if _ok is None:
            _ok = relations.present(_values)
        state.verdict("p1", "a2", _record, _ok, ...)

    # ── o1 (output) ──
    return {"outputs": outputs.rows(state, spec.config("o1")["rows"]),
            "extracted_state": state.extracted()}
```

Note what is *absent*: no graph reasoning, no decision about which artifact
`p1`'s verdict lands on (`verdict_targets` said), no check for whether `a2`
loops (`loop_scopes` said). The sequence is flat because each step iterates its
parent's records internally.
