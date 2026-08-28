# Blocks 6–9 — runtime, skills, codegen, eval, heal

Written at the end of the build session. Companion to [plan.md](../plan.md),
which remains the design of record, and to
[session-context.md](session-context.md), which covers blocks 0b–5.

This file records what got built, what it found, and what was deliberately left
out. Where something is incomplete, it says so and says why.

---

## What runs

```bash
cli specs                                       # frozen specs on the bus
cli pull  --spec cce7715b                       # bus -> processes/<id>/spec.json
cli fetch --process final_test --live           # snapshot the channel to fixtures/
cli gen   --process final_test                  # spec -> processes/<id>/agent/
cli eval  --process final_test                  # score against expected/
```

Both frozen specs generate an agent from the same nine templates, and both pass
`verify_generated`. That is the generality claim in the only form worth having:
two industries, one template set, `diff`-able side by side.

---

## Block 0 — the Composio spike

Green, and first, as the plan insisted. Authorized Gmail through Composio,
listed the inbox, downloaded a PDF attachment, extracted its text, printed it.
Nothing downstream had to shift.

One thing it did not catch, because it could not: the SDK requires an explicit
toolkit version or an explicit opt-out per call. That surfaced in the first
adapter call, not the spike, and cost a few minutes rather than an hour.

## Block 6 — `runtime/`

Built and made green against a **synthetic, domain-free spec** (`a1 → p1 → o1`,
fields `f1`/`f2`) before any real process existed. This was not optional and it
paid for itself: the API has no shape anywhere that came from one process.

**Four relations, not ten.** `present`, `equals`, `greater_than`,
`exists_matching`. The board under test needs only the first and the last; the
other two cost twenty minutes and mean `relations.py` is *not* precisely the set
one board required — which is what overfitting looks like from the outside.
Skipping `absent`, `in_set`, `within`, `older_than`, `newer_than`, `less_than`
is a coverage cut, stated here rather than hidden.

**One Composio adapter, parameterised by action slug.** `composio.gmail` and
`composio.slack` are two rows in `channels/registry.py` pointing at the same
class with different slugs, and a test asserts that. `http.get` is its own
module because that is a real provider boundary — different auth, different
retry, different response shape. Adding a provider under an existing
integration layer is a row; adding a genuinely new transport is a file.

**Temporal is a thin host.** `workflow_base.py` is a workflow that calls one
activity. That is the entire Temporal surface.

## Block 6b — the `impl` path

Without this, "described, not picked" is only true when the description happens
to fit four functions. A policy fitting none of them must still compile, or the
operator is blocked waiting on an engineer to ship relation five.

`runtime/validate_impl.py` gates a model-written body on three things: a
declared surface (`signature`, `reads_fields`, `helpers` emitted alongside the
body as a contract), an AST validator, and human sign-off via `confirmed_by`.

**The three planted bodies are in the suite** — one importing `os`, one reading
an undeclared field, one calling `eval` — plus attribute access, dunder access,
`global`, and `__import__`. They were written with the validator, not after.
That test file is the entire defence for letting a model write code that ships
in a spec, and it is the first thing that gets skipped at hour four.

A compiled body also runs with `__builtins__` emptied, so a gap in the validator
is a `NameError` rather than a capability.

## Block 7 — fetch, and the reference agent

`cli fetch` resolves the board's `tool` through the dispatch table and snapshots
payloads to `processes/<id>/fixtures/`. The path is generic — a board whose
channel is `http.get` snapshots identically.

`processes/final_test/reference/` is the **hand-written** agent, kept after
codegen existed. It proved the runtime could express the process before a model
was taught to emit calls into it, and it is codegen's known-good target: when a
generated agent fails, the diff says which layer is wrong.

### One finding worth recording

The board's channel `match` is prose the operator wrote — *`Subject line
"Pre-Alert Documents" or "Pre Alert Documents"`*. Passed to Gmail it returns 7
of the 15 messages actually present, because the real subjects say "Pre-Alerts
Documents" and other variants.

**Prose is not a provider query language.** The engine passes `match` through
verbatim and does not second-guess it. `cli fetch --query` overrides it for one
snapshot, announces loudly that it is doing so, and never writes it to the spec,
so `spec_hash` is untouched. The under-fetch is a finding for the next review
round, not something an adapter should paper over.

## Blocks 8 and 9 — codegen, skills, eval

**`cli gen` is deterministic template-filling; the skill is the judgment
layer.** Same spec in, byte-identical code out — which is what keeps
`spec_hash` meaningful. The substitution is deliberately dumb (`{{key}}`
replacement, no expressions, no control flow) so that no structural decision can
migrate out of the compiled block and into a template.
`skills/spec-to-agent/SKILL.md` is what reads the spec and the runtime surface,
maps nodes to templates, and reports gaps instead of improvising.

`SKILL.md`'s worked example uses the synthetic spec. A real one would pass the
noun lint if phrased carefully and still teach the model one industry.

`cli/verify_generated.py` asserts imports resolve only to `runtime.*` and
stdlib, that no runtime verb is redefined, and that **any function the module
defines is byte-identical to an `impl.body` in the spec** — a string comparison,
not a judgment call.

`cli eval` is a command, not a skill: it is deterministic and there is nothing
for a model to decide. It reports expected, actual, **and `extracted_state`**.

---

## What the eval actually found

This is the part worth reading, because the report diagnoses the *board*, not
just the agent — which is what `extracted_state` is for.

`MMAU1407799` (one invoice, one certificate) passes cleanly. `CAAU4056270` does
not, and the extracted state says precisely why:

| Observation | Classification | Where the fix belongs |
|---|---|---|
| 9 `art_2` records, all `U03/25-26/4790` — one per batch row, not one per invoice | extraction | **Spec.** `identity_merges` is empty: the board never set an `identity_key` on `art_2`, so nothing deduplicates. |
| `Batch Number` holds `"UCB26009A, UCB26016A, UCB26017A, UCB26018A"` — four values in one field | extraction | **Spec.** The board models a batch as a field on the invoice rather than as its own artifact, so a one-to-many is being flattened into a string. |
| Certificate batch numbers read `UCB26009`; invoice batch numbers read `UCB26009A` | extraction | Genuinely ambiguous. `squash` normalises whitespace and case but cannot invent a suffix. Needs a human ruling on whether the trailing letter is significant. |
| Every `art_4` field is `null` | extraction | **Spec.** The board's field names (`ACDA`, `SDF`, `EDF`) are placeholders the operator typed, not names that appear in any document. Extraction correctly finds nothing. |
| `invoices_failed` cannot reach 1 from failing goods | logic, but unfixable in the agent | **Spec.** `pol_1` lands its verdict on `art_4` only. No edge propagates a child's failure to its parent, so the board cannot express "an invoice fails when one of its goods fails". |

**Every one of these is a spec-level finding, and the heal skill's own rules say
to halt on them rather than patch.** Editing the agent to compensate — merging
records the spec never asked to merge, hardcoding a suffix rule, propagating a
verdict across an edge the operator never drew — would produce a greener suite
and a worse system, and would break the property that generated code is
traceable to a spec hash.

The correct next action is another review round on the board: set an
`identity_key` on `art_2`, promote the batch to its own artifact, correct the
`art_4` field names against a real document, and draw the edge that makes an
invoice fail when its goods do. Then re-freeze and regenerate. That is the loop
working as designed; it is just a longer loop than one heal pass.

### Two of the seven metrics are not scored

`failed_coa` and `coa_success` describe certificates that matched nothing — the
reverse direction of the cross-reference. The board wires `pol_2`'s verdict onto
`art_2` only, so nothing in a run of this spec produces a verdict against
`art_3`. The runner reports them as `not scored` with that reason attached
rather than inventing a check the operator never drew.

`MNBU0458316` is discarded by the suite. The runner reports it as
`skipped (discarded)` and counts it as a pass, so the skip is visible rather
than silently green.

---

## Deliberately out of scope

Stated, not half-built:

- **The fail edge.** The outbound send on failure, `workflow.wait_condition`,
  the correlated reply signal, `logic.rescope`, the timeout path.
  `compiled.fail_handlers` is empty on both frozen specs, and `cli gen` prints a
  note if it ever is not. A workflow that parked with no signal able to wake it
  would be worse than one that does not park.
- **Six of the ten relations**, as above.
- **`heal_guard.py`.** The constraints it would enforce are written as
  instructions in `skills/heal-agent/SKILL.md`, which is where they exist for
  the model. Mechanising them is the next thing to build.
- **The re-freeze → v2 rebuild cycle.** Halting and surfacing a comment is
  cheap; regenerating from a v2 spec is a second product surface.

## Known-imperfect

- The process is called `final_test` because that is the `process_id` in the
  frozen spec, and the spec hash depends on it. Renaming it would invalidate the
  build ID, so it stays.
- Extraction is slow on first run — one model call per artifact node per parent,
  over emails carrying up to 27 attachments. Results are cached to disk keyed on
  model + prompt, so the second eval and every heal iteration replay instantly.
  `ANTHROPIC_MODEL` is pinned for exactly this reason.
- `.env.local` now overrides ambient shell state, and every credential is
  announced masked at startup. A stale exported key shadowed the working one and
  produced a 401 twenty minutes after the identical call had succeeded; one line
  at startup makes the next occurrence a one-line diagnosis.
