---
name: spec-to-agent
description: Generate a runnable agent from a frozen spec. Invoked by `cli gen --process <id>`, which places spec.json, RUNTIME_API.md and TEMPLATES.md in a working directory and asks for agent.py. Read only those files.
---

# spec-to-agent

Turn a frozen spec into a runnable agent.

## Your input is the frozen spec and the runtime surface. Nothing else.

Two files, and they are both in your working directory: `spec.json` and
`RUNTIME_API.md`. That is deliberate and it is the property under test.

Not the project README. Not the design document. Not the conversation that
produced the board. Not an example from the process you are generating. If you find yourself needing to know what the business does
in order to emit correct code, **stop and say so** — that means the spec is
insufficient, and the spec being sufficient is precisely the property under test
here.

Every example you will see — the templates in `TEMPLATES.md` and the worked
example at the bottom of this file — uses a synthetic spec (`a1`, `p1`, `f1`)
for the same reason. An example drawn from a real industry would pass the noun
lint if phrased carefully and still teach you that industry.

## What generation is, and what it is not

**You write `agent.py`.** A model runs in this path — that is the point of it
being a skill. The consequence is stated plainly rather than hidden: the same
frozen spec can produce different code across two runs. `spec_hash` still
identifies the *input* exactly, and `verify_generated.py` still constrains the
*output*, but byte-identical regeneration is not a property this system has.

That is why the lint matters more here than it would against a template filler,
and why the constraints below are absolute rather than stylistic.

**The templates in `TEMPLATES.md` are the shapes to emit.** They exist so you
see the intended structure rather than inventing one. Fill their placeholders
from the spec and change nothing else about their structure.

**A hand-written reference agent exists** at `processes/<id>/reference/agent.py`
for at least one process, and generated output is diffed against it. That diff
has already caught one real bug — a template chosen on whether a parent *exists*
rather than on whether the parent *has fields*. Assume your output will be read
that closely.

## Steps

1. **Read `spec.json`.** Read `compiled` in particular: `topo_order`,
   `loop_scopes`, `verdict_targets`, `joins`, `identity_merges`,
   `propagations`, `fail_handlers`.
2. **Read `RUNTIME_API.md`.** These are the only verbs your code may call.
3. **Read `TEMPLATES.md`.** Map every node in `topo_order` to one template.
   Each `policy` maps by its `check.relation`, or by having an `impl`. If a node
   maps to no template, **write nothing and say which template is missing.**
   Do not improvise a shape.
4. **Write `agent.py`** into the working directory: the module shell, then one
   step per `topo_order` entry, in order.
5. **Stop.** The caller runs `verify_generated.py`. If it fails you will be
   asked again with the findings; regenerate the file, do not patch around
   them.

## Rules

These are verbatim constraints, not guidance.

- **One step per `topo_order` entry, in order.** Never reorder, never infer a
  dependency, never skip a node.
- **Look up the template from `compiled.templates[node_id]` when the spec
  carries it; otherwise from the node's `primitive` and its enum value
  (`check.relation`, `output.fn`).** `registry_version` 1.0 specs do not emit
  `compiled.templates`, so the second route is the live one today. Fill the
  template from `node.config`. The template set and the registry extend together
  or not at all.
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
- **`compiled.identity_merges` names artifacts whose records must be merged.**
  Emit one merge immediately after that artifact's extraction step and before
  anything reads it. Skipping it is silent: the run completes and every count
  over that artifact is inflated by however many times a record arrived twice.
- **`compiled.propagations` may be empty too.** When it is not, emit one
  `state.propagate(from, to)` per entry, **after every policy and before the
  output**. Use `from` and `to` exactly as the compiler wrote them: the edge
  runs parent to child and verdicts travel the other way, and that inversion is
  already resolved. Propagations are not nodes, so they never appear in
  `topo_order` — they are the one thing you emit that the topo order does not
  name.
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
