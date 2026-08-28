# Session context — review agent + canvas debugging

Written 2026-08-27. Companion to [plan.md](../plan.md), which remains the
authority on design. This file records what happened in one working session:
what was wrong, why, what changed, and what is still open. It is a handoff
note, not a design document.

---

## Where the build is

**Blocks 0b–5 of [plan.md §11](../plan.md) are done.** Two processes have been
drawn on the canvas, taken through review, and frozen — `frozen_specs` holds
three rows across two boards, which is block 5's actual bar (draw a *different*
process and reach freeze, not assert about a JSON fixture).

**Blocks 6–11 are greenfield.** No `runtime/`, no `cli/`, no
`skills/spec-to-agent/`, no `processes/`. That is the whole back half: the verb
library, the Temporal worker, Composio fetch, codegen, the AST validator, the
eval runner and the heal loop, and the fail edge.

`.env.local` now carries working Composio and Temporal credentials. Block 0a
(the spike that proves both external dependencies end to end) was scheduled
first precisely so an auth wall could not surface late; having keys is not the
same as having pulled ten messages, opened a PDF, and run one Temporal workflow
with a signal. If that has not been done end to end, it is the cheapest first
hour of block 6.

---

## What was wrong, and why

Eight defects, found by driving real boards through the UI rather than by
reading code. They are listed together because six of them share one root
cause: **several independent places each decided for themselves what a piece of
state meant, and they disagreed.**

### 1. Prose was being written into `check`

`unresolved_policy` rendered as a free-text question whose mutation was
`set_config_key(check)`. So the answer to "what does this check?" landed in
`check` — a `derived` key that is supposed to hold `{relation, params}`
produced by the resolver and confirmed by her.

[plan.md §4](../plan.md) is explicit that a missing `derived` key is work for
the agent, not a question for her. It had become a question for her, and her
answer occupied the slot the agent was meant to fill.

**Fixed** in `elaborate.ts`: `unresolved_policy` retargets both its mutation and
its `evidence.key` to `describes`, which is what the resolver reads. Retargeting
`evidence.key` also closes the same hole through the Pass B prefill path.
`render.ts` wording changed to ask for the whole description, since the answer
replaces rather than appends.

### 2. "Resolved" meant four different things

Four consumers each tested `config.check != null` independently: the
`required_if` conditions, the worker's resolution loop, the canvas fold rule,
and freeze. A sentence in `check` therefore read as *resolved* everywhere at
once — the resolver skipped the policy, the canvas folded its card into the
parent record, and the board went quiet still holding a check nothing could
compile.

**Fixed**: `policyIsResolved()` in `conditions.ts`, exported through both the
barrel and the client subpath, requires an object with a `relation` (or an
`impl` with a `body`). All four consumers now share it.

### 3. A condition that names its own finding code was double-gated

The `required_if` loop gated on `isEmpty(config[key])`. With prose in `check`,
`neither_resolved` fired but no finding came out. A condition that names its own
code *is* the predicate; the emptiness test is now skipped for those.

### 4. Dedupe dropped the config key

The review worker deduped on `(code, anchor)`. One finding code fires on one
node for several different keys — `missing_required_key` on a policy is
`describes`, then `on_fail`, then `on_absent` — so answering the first question
on a card silenced every later one on that card, permanently. One board reached
ten blocking findings and zero comments.

**Fixed**: the tuple is now `(code, anchor, key)`. The comments table does not
store the key, so it is read back via `mutation->>'key'`. Extracted to
`packages/compiler/src/asked.ts` because two processes need the same answer and
must not drift — and because the worker's `index.ts` opens a database
connection at import, which made the rule untestable where it was.

### 5. Reconciliation closed every Pass B comment, unanswered

`reconcileComments` closes any open comment whose finding no longer holds.
Correct for Pass A. Catastrophic for Pass B, and the reason is structural: **a
proposal exists precisely because the compiler cannot see what it is
proposing.** `elaborate()` emits none of `policy_resolution`, `missing_node`,
`missing_edge`, `cardinality` — so no Pass B comment can ever be in the live
set, and every one of them was closed on the next answer she gave, mutation
never applied, marked `resolved_directly` as though she had fixed it herself.

The confirmation that resolves a policy is a Pass B comment. Losing it left the
policy unresolved while dedupe, remembering the question was asked, refused to
ask again: a blocking finding with no question attached and no route to one.

**Fixed** in `postgres.ts`: `retired()` splits by pass. Pass A retires when its
finding stops holding. Pass B retires only when `validate()` says its mutation
has become impossible — she deleted the card it hung off. Reconcile's key also
gained the config key, matching the worker.

**Also fixed**: a comment auto-closed by reconciliation no longer counts as
"already asked". It was never answered, and if the finding returns, asking again
is correct. This is what unsticks an already-damaged board without SQL surgery.

### 6. "No, they're different" deleted the record

`CommentCard` routes on `option.rejects` — with the flag it declines, without it
it *answers*, which applies the comment's mutation. `compression`'s mutation is
`merge_nodes`. Its reject option was the only one in `render.ts` missing the
flag, so declining a merge performed it and a record vanished.

Not a wording bug — both labels read correctly and only one behaved — and
silent, since the mutation applies cleanly and the only evidence is a missing
node. `CommentCard`'s own file header warns about exactly this hazard.

### 7. Pass B proposed structure the compiler had already ruled on

Pass B proposed adding a "send" channel because an output node had no outgoing
edge. True, and irrelevant: an output *is* a terminal, and `elaborate()` agrees.
The prompt listed primitives as bare tags with no semantics.

**Fixed** in `propose.ts`: the prompt now explains the four card kinds, states
that an output with no outgoing edge is a finished board, and says reachability,
terminality and dead cards belong to the type checker. Also extended the
`missing_edge` hint to cover a check described as comparing two records that
only has one record wired into it.

### 8. An output could not be sent anywhere

The only outbound paths were `policy → channel` (per-record fail notice) and
`artifact → channel`. Neither expresses "email the finished checklist once, at
the end" — a real requirement. Drawing that edge produced a blocking
`edge_not_expressible`, and the canvas, which drew nothing for a role it did not
recognise, swallowed the line: in the store, blocking freeze, invisible, and
refused as a duplicate on redraw.

**Added**: `report` role (`output → channel`). Unlike a fail edge it is a data
edge and stays in `topo_order` — it fires once, after the output is computed.
`no_terminal_path` already counted outbound channels as terminals and
`has_inputs` already required `request`, so the surrounding machinery needed no
change. The self-talk guard was widened from fail edges to any send edge, so a
report cannot be mailed into the inbox the process reads from.

`fold.ts` also gained an `invalid` kind, so a connection the compiler cannot
express is drawn as a red dashed line she can select and delete, rather than
disappearing.

---

## Tests added

| File | Covers |
|---|---|
| `tests/dedupe.test.ts` | Dedupe suppresses a question only when the same question was asked |
| `tests/reconcile.test.ts` | Pass B comments survive until settled; Pass A still closes when its finding goes |
| `tests/declining.test.ts` | Every declining option carries `rejects`, across every option set the renderer can produce |
| `tests/report-edge.test.ts` | The `report` role; no edge she draws is invisible |
| `tests/resolution-gate.test.ts` | Extended: prose in a derived key never counts as resolution |

`declining.test.ts` and `reconcile.test.ts` are written over the *class* rather
than the instance — they sweep every rendered option set and every comment
shape, so the next occurrence of the same mistake fails too. Reverting the
one-line `rejects` fix makes two of them fail with a named finding.

---

## Open, and known

### The suite is red at HEAD

`tests/report-edge.test.ts` was committed mid-edit in `dfd6a9c`. Two failures,
both in that file; all 16 other test files pass and the source is fine.

1. `validate` is used but not imported — one-line fix.
2. `every edge in the store is drawn` fails on a real bug (below).

### A second edge between a parent and its folded child still vanishes

`fold()` drops any edge whose endpoints resolve to the same card
(`fromCard === toCard`). Draw `art_1 contains art_2`, then draw `art_2 → art_1`:
the second edge lands on the card it started from and disappears — in the store,
blocking freeze, invisible, refused as a duplicate. **This is the same class as
defect 8, in its other form, and it is still present.**

The in-progress fix was to cancel the fold when more than one edge connects the
pair — a folded card can represent exactly one edge (the indentation, or the
row), so a second one has to force both cards back onto the canvas. That change
was reverted before it was verified; the comment in `fold.ts` claiming this case
"can only happen if a node was folded into a card that itself got folded" is
wrong and should be corrected whenever it is fixed.

