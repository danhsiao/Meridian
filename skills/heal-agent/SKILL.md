---
name: heal-agent
description: Classify eval failures and patch a generated agent. Use when `cli eval --process <id>` reports failures — read the report, state a root cause per failure, patch inside processes/<id>/agent/, and stop without re-running.
---

# heal-agent

Read an eval report, work out *why* each case failed, and patch the agent.

## The loop, and where you sit in it

```
cli eval --process <id>     deterministic; produces reports/eval.json
                            a human reads it and invokes this skill
        /heal-agent         you classify, state a root cause, patch, stop
cli eval --process <id>     the human re-runs it
```

**You do not re-run the suite.** The human does, and that is the checkpoint. A
healer that patches and re-runs in one breath can converge on green without
anyone having seen the reasoning, and a green suite nobody can explain is worth
less than a red one somebody understands.

Classification and patching stay in one skill deliberately. Splitting them would
allow a patch to happen without a stated root cause, which is the constraint
that keeps this from guessing.

## Steps

1. **Read `processes/<id>/reports/eval.json`.** It carries, per case: expected,
   actual, the failing metrics, and `extracted_state` — the values the agent
   actually pulled.
2. **Classify each failure before writing anything.** Every failure is one of:

   - **extraction-failure** — the agent pulled the wrong values. The counts are
     wrong because the input to the check was wrong. Look at
     `extracted_state.records`: missing rows, rows from the wrong document,
     values with stray whitespace or different formatting on the two sides of a
     comparison.
   - **logic-failure** — the agent pulled the right values and reached the wrong
     verdict. `extracted_state.records` looks right,
     `extracted_state.verdicts` does not.

   The distinction decides where the fix goes. An extraction failure is fixed in
   how the extraction is scoped or hinted; a logic failure is fixed in how a
   relation is called. Fixing one as though it were the other is how a heal loop
   turns into a random walk.
3. **State the root cause in one sentence per failing case**, naming the
   evidence in `extracted_state` that supports it. Before any diff.
4. **Patch**, inside the boundary below.
5. **Append a pass to `processes/<id>/heal-log.md`**: which cases failed, the
   root cause for each, the diff, and the score you started from. Leave the new
   score blank — the human fills it in when they re-run.
6. **Stop.**

## The boundary

These are hard constraints. Each one exists because violating it produces a
green suite and a worthless agent.

- **Write only inside `processes/<id>/agent/.`** Never `runtime/`. Never another
  process's directory. Never `cli/`. The runtime is a shared library — a fix
  there to make one process's test pass is a change to every process.
- **Never edit `expected/`.** It is the shortest path to a green suite and it
  destroys the only independent measure of whether the agent works.
- **Never edit the frozen spec.** That is the IR, and it is immutable by
  construction. If the spec is genuinely ambiguous or wrong, **halt** and say
  so — the fix is another review round and a new freeze, not a local edit.
- **Never weaken or delete a line carrying `# assumption c_NN`.** Those encode
  decisions the type system could not make — which of two conflicting source
  documents governs, say — made by a human and traceable to a comment. Eroding
  one silently is exactly what the marker exists to prevent.
- **Never widen a comparison just to make a case pass.** Loosening a match until
  everything matches is not healing. If two values differ, say why they differ
  before deciding that the difference is immaterial.

## What a good patch looks like

The agent is orchestration over runtime verbs, so a legitimate patch is almost
always one of:

- **changing how an extraction is scoped or hinted** — a `source_hint` or
  `scope_hint` that pulls rows from the right document rather than every
  document in the payload;
- **changing which comparison is passed into a relation** — `key=squash` rather
  than exact equality, when the two sides are transcribed from different
  documents by different people. Note the shape: the comparison is passed *into*
  the relation as data. The engine's own definition of a match is untouched, and
  the change stays inside this process.

If a patch requires a verb the runtime does not have, that is a runtime gap.
Say so and halt. Do not write the verb into the agent — `verify_generated.py`
will reject it as a defined function that is not a spec `impl`, and it would be
right to.

## The log is the deliverable

`processes/<id>/heal-log.md` reading `7/11 → 9/11 → 11/11` with a stated root
cause at each step is stronger evidence of a designed loop than an autonomous
run that happens to converge. Write it for someone who was not there.
