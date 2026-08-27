# Build Plan — Autonomous Workflow Engine (Meridian Take-Home)


## Context

The repo is empty except [README.md](README.md) — this is a greenfield 48-hour build. The README is a strong design document; the job now is an execution plan that makes its central claim mechanically true rather than rhetorically true.

**This plan supersedes the README.** Where the two disagree, this file wins; the README is rewritten from it in block 11, once the build has settled what's actually true. References to "the README" below mean the current draft, and are kept where they explain why something here differs from it.

**The claim:** *the review agent asks exactly the questions the compiler would ask, because they read the same file.* The frozen spec is a valid translation not because a human checked it, but because the thing that generates the questions and the thing that consumes the answers are the same type system.

As the README currently stands, that claim is aspirational. Requirements live in four places that can drift: `registry.json`, Pass A's hand-written graph checks, the five freeze predicates, and the codegen templates. This plan collapses all four into **one function with two outputs**, which is the single most important structural decision here:

```
elaborate(nodes, edges) -> { ir, findings }
```

One traversal. Where it can resolve the graph, it writes IR. Where it hits a hole, it emits a Finding. Then:

- **Review** renders each Finding as a canvas pin carrying the mutation that fills that exact hole.
- **Freeze** is `findings.filter(blocking).length === 0`.
- **Codegen** reads `ir` — which freeze wrote *into* the spec — and never re-derives a thing.

A question exists exactly when the elaborator hit a hole it could not fill. The IR is what it filled in everywhere else. That is why the frozen spec is sufficient: not because someone checked it, but because the only way to reach a hash is to leave the elaborator with nothing left to ask.

### Decisions locked with the user

| Fork | Decision |
|---|---|
| Compiler front-end | Single TS `elaborate()`. Freeze writes a `compiled` IR block into the spec. Python codegen reads only. |
| Execution | Temporal stays — it executes the generated code. Skeleton must be process-agnostic. |
| Pass B | Strict: proposals only. It may propose structural edits; it may never assert completeness. |
| Demo scope | Review loop → converged freeze; codegen + 10-fixture self-heal; live Composio fetch. |
| Fail edge | **Built and demoed.** Outbound discrepancy email sends live via Composio; the durable wait is real in demo and production, only the timer differs (`PT30S` vs `P5D`). Resume is re-entry into the *same* execution with narrowed scope. Inbound Gmail *polling* stays cut — the signal is injected by a fixture shaped like an inbound message, so `correlate_on` still executes. |
| Composio | Live `fetch` snapshots real Gmail messages into `processes/<id>/fixtures/`; heal loop replays from disk. |
| Generality | Enforced structurally (§1). A second process drawn on the canvas and taken through review → freeze. No second eval suite. |
| Registry shape | Three sections — `kinds` (what's required), `ask` (how it's elicited), `templates` (what codegen reads), tied together by a CI test. |
| Free text | Confined by `binding`: `control` keys answer from a computed option set, `prompt` keys are prose bound for an extraction prompt. Nothing free-text reaches control flow. |
| Policies | **Described, not picked.** She writes the check in her own words; the review agent clarifies against her artifacts' fields and resolves it to a `check` (one of ten relations) or an `impl` (a function frozen into the spec), plays it back in her field names, and she confirms. No runtime LLM on either path. |
| Framing | "Unlimited nouns, enumerated verbs" no longer holds. **Structure is compiled, judgment is elicited.** |

---

## 1. Generality is a build constraint, not a claim

Pharmaceutical import receiving is **one consumer** of this system. Nothing outside `processes/`, `examples/`, and board data may know it exists. This is not a style preference — it is the thing that makes §5's "meaning is position in the graph" true, and it degrades silently unless something checks it. So it gets checked.

**The noun lint.** `tools/check-nouns.mjs` greps a denylist — `invoice`, `batch`, `certificate`, `coa`, `hts`, `anda`, `ndc`, `fda`, `shipment`, `container`, `pharma`, `pre-alert` — across `packages/compiler/`, `runtime/`, `apps/web/`, `skills/`, `cli/`. Zero hits, case-insensitive, or the build fails. Domain nouns are permitted in exactly three places: `processes/`, `examples/`, and rows in the database. Run it in CI and as a pre-commit hook.

**Four rules the lint operationalises:**

1. **The registry is grammar.** `kinds` keys off edge topology and node primitive only; `ask` describes elicitation, not subject matter. No known document types, no vocabulary, no industry.
2. **The runtime holds verbs, never nouns.** `present(record, field)` — not `check_good_fields()`. Every function signature takes its subject as data, including a pasted `impl` body, whose `signature` is field paths from her board.
3. **Generated code is orchestration only.** It walks `ir.topo_order` and calls runtime verbs. If a domain concept appears in generated code, a template is wrong.
4. **The CLI is parameterised.** Every command takes `--map` or `--spec`. No default process. No path that only works for one board.

**Three proofs, in ascending cost:**

- `examples/` holds seed boards from two unrelated domains — import receiving and loan-file completeness. **Both must elaborate to zero blocking findings and freeze in CI.** This is the generality proof as a test rather than a screenshot, and the boards are just JSON. (A third, permit review, was cut for time — see §11.)
- The runtime is built against a **synthetic, domain-free spec** (`a1`, `p1`, `o1`) *before* the receiving agent exists — see §8. The API cannot be shaped around one domain if the first caller has no domain.
- The extension path is four files for an output function or a transport — registry entry, `ask` block, runtime verb, template. If that list ever grows, the seams are in the wrong place. (Policies no longer extend this way at all: an unmatched check becomes an `impl`, so she is never gated on an engineer.)

**Transports are a dispatch table.** `runtime/channels/registry.py` maps a `tool` string to an adapter: `composio.gmail` today, `composio.slack` / `http.get` / `upload` later. A channel's only contract is that it returns a payload. Gmail is one row in that table, not the design.

---

## 2. The context firewall

The take-home handed you an SOP document, personal notes, a sample invoice, and an eval suite. The product's premise is that **no SOP exists** — the whiteboard is where the process gets written for the first time.

Both are true, and the boundary between them is the most important thing to state plainly: **the provided SOP is how you acquired the tacit knowledge, not an input to the system.** You read it, then played the domain expert and drew the board. Nothing downstream ever sees it. If the review agent were fed the SOP, the demo would be theatre — an agent reconciling two documents while claiming to elicit from one.

So it becomes a rule with teeth. Three consumers, each with a strictly-defined input, each seeing **strictly less** than the one before:

| Stage | Sees | Never sees |
|---|---|---|
| Pass A | `nodes`, `edges`, `registry.json` | any English at all |
| Pass B | `nodes`, `edges`, free text **authored on the board** | the SOP, the notes, the sample invoice, the fixtures |
| Codegen | the frozen spec + `compiled` IR | the board, the notes, the project README |
| Heal | eval report + generated code | the spec's provenance, the source documents |

Each stage's output must be sufficient for the next *on its own*. That is what "the frozen spec is sufficient to hand to a coding agent" means, checked at every boundary rather than only the last one — and it's what makes each round of review an honest test instead of a replay.

**Enforced, not intended:** the review worker builds its Pass B prompt from a pure function of `(nodes, edges)` with no filesystem access; a unit test asserts the assembled prompt contains no string from `docs/source-material/`. Same shape as `verify_generated.py`'s no-untraceable-literal check (§9).

> The sharpest version of this, worth a line in the README: the provided SOP and the provided notes **disagree with each other** — four required fields versus five. Written-down process documentation is already incomplete and self-contradictory. That isn't an inconvenience in the assignment; it's the evidence for the premise. The take-home's own materials argue that the canvas has to be where the process gets written down properly for the first time.

---

## 3. Architecture

```
┌─ Interactive Canvas ────────────────┐
│  apps/web (Next.js + React Flow)    │
│  draws nodes/edges, renders pins    │
└──────────────┬──────────────────────┘
               │ writes rows
┌──────────────▼──────────────────────┐
│  Postgres (Supabase) — THE BUS      │
│  nodes edges comments review_runs   │
│  frozen_specs                       │
│  spec_builds  ── Realtime ─────────►│  back to browser
└──────┬───────────────────────┬──────┘
       │ LISTEN                │ read
┌──────▼─────────────┐  ┌──────▼───────────────────┐
│ review-worker (TS) │  │ cli (Python)             │
│  Pass A = elaborate│  │  fetch / gen / eval /    │
│  Pass B = model    │  │  heal / run              │
│    (proposals only)│  └──────┬───────────────────┘
└──────┬─────────────┘         │
       │                       │ invokes
┌──────▼──────────────┐ ┌──────▼──────────────────┐
│ packages/compiler   │ │ processes/<id>/agent/   │
│  elaborate()        │ │  generated orchestration│
│  registry.json      │ │      links against      │
│  freeze() canonical │ │ runtime/  (the verbs)   │
└─────────────────────┘ └──────┬──────────────────┘
        the type system        │ executed by
                        ┌──────▼──────────────────┐
                        │ Temporal worker         │
                        └─────────────────────────┘
```

The browser never calls the review agent. The CLI never calls the browser. Everything writes rows; Realtime pushes them.

### Repo layout (graded on "could a teammate pick this up")

Read top to bottom, the tree should make it obvious that one domain is a tenant, not the subject.

```
packages/compiler/         ← the type system. zero deps, pure functions, no nouns.
  registry.json              kinds / ask / templates — grammar only (§4)
  options.ts                 computed option sources for `control` keys
  elaborate.ts               THE traversal: { ir, findings }
  findings.ts                closed Finding code enum + severity
  mutations.ts               closed Mutation enum + appliers (no inverses)
  render.ts                  Finding -> human question + answer widget
  freeze.ts                  blocking===0 -> canonical() -> sha256
  __tests__/                 one synthetic fixture per finding code
packages/review-worker/    ← LISTEN loop, Pass A adapter, Pass B model call
apps/web/                  ← canvas, comment panel, locked board. renders kinds, not domains.
runtime/                   ← Python. ten relations + orchestration. knows no process_id.
  channels/
    base.py                  Channel protocol: returns a payload
    registry.py              tool string -> adapter  (the dispatch table)
    composio_gmail.py        one row in that table
  extract.py  identity.py  relations.py  guards.py  helpers.py
  outputs.py  state.py  logic.py
  activities.py  workflow_base.py
  tests/                     against a synthetic domain-free spec
skills/spec-to-agent/      ← SKILL.md + templates/ keyed on registry enums
processes/<process_id>/    ← per-process, everything domain-specific lives under here
  agent/                     generated code. committed. the deliverable.
  fixtures/                  snapshotted channel payloads
  expected/                  labels  (+ adapter for the provided suite format)
  captured/                  outbound sends recorded during eval/heal, never delivered
  heal-log.md
cli/                       ← fetch | gen | eval | heal | run   — all take --map/--spec
examples/                  ← seed boards: receiving, loan-file (both freeze in CI)
docs/source-material/      ← the provided SOP, notes, sample invoice.
                             read by you, never by the system (§2)
tools/check-nouns.mjs      ← the lint that keeps all of the above honest
supabase/migrations/
.env.example               ← every key, no values. .env.local is gitignored (§3.1)
```

Two splits carry the weight:

**Generated code is orchestration; `runtime/` holds the verbs.** *Structure is compiled, judgment is elicited* — the graph, execution order, loops, joins and waits all resolve at freeze; what a check *means* is elicited from her, confirmed, and compiled to Python before the hash. The one thing generated code may contain beyond orchestration is an `impl` body pasted verbatim from the spec, and `verify_generated.py` checks that byte-for-byte. This is what makes "rewriting the skeleton is not a fix" enforceable rather than aspirational — see §9.

**`processes/<process_id>/` is the only place a domain exists on disk.** Import receiving is a directory, not a layer. Adding a second process adds a sibling directory and touches nothing else — which is the claim, made checkable by `ls`.

> This replaces the README's flat `/evals/` and `/agents/` paths, which quietly assume one process per repo.

---

### 3.1 Configuration and secrets

`.env.example` is committed with every key present and every value empty; `.env.local` holds the real values and is gitignored. Nothing else in the repo carries a credential.

```bash
# ── Supabase ───────────────────────────────────────────────────────────
NEXT_PUBLIC_SUPABASE_URL=            # browser-safe, used by apps/web
NEXT_PUBLIC_SUPABASE_ANON_KEY=       # browser-safe, Realtime subscription
SUPABASE_SERVICE_ROLE_KEY=           # server only — review-worker + cli
DATABASE_URL=                        # direct postgres conn: LISTEN/NOTIFY

# ── Anthropic ──────────────────────────────────────────────────────────
ANTHROPIC_API_KEY=                   # Pass B relabelling + runtime extraction
ANTHROPIC_MODEL=claude-sonnet-5      # pinned; a model swap changes eval results

# ── Composio ───────────────────────────────────────────────────────────
COMPOSIO_API_KEY=
COMPOSIO_USER_ID=                    # entity the Gmail connection belongs to
COMPOSIO_GMAIL_CONNECTION_ID=        # resolved once in block 0a, then pinned

# ── Temporal ───────────────────────────────────────────────────────────
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=workflow-engine
# TEMPORAL_TLS_CERT= / TEMPORAL_TLS_KEY=   # only if pointed at Temporal Cloud

# ── Run mode ───────────────────────────────────────────────────────────
CHANNEL_MODE=capture                 # capture | live  — see below
```

**`CHANNEL_MODE` defaults to `capture`.** Live sending is opt-in, per run, via `--live` on the CLI. Defaulting the other way means one forgotten flag during a heal loop delivers dozens of real emails; defaulting to capture means the worst case is a demo where nothing arrives and you re-run with the flag. Fail safe in the direction that's recoverable.

**Credentials never enter the spec.** `tool: "composio.gmail"` names a transport; the adapter resolves its key from the environment at run time. So `spec_hash` never depends on a secret, a frozen spec is safe to commit and share, and rotating a key doesn't invalidate a build ID. This falls out of the transport dispatch table (§1) rather than being a separate rule.

**Who reads what** — three processes, three subsets, and the split is a security boundary, not a convenience:

| Process | Reads |
|---|---|
| `apps/web` | `NEXT_PUBLIC_*` only. The service-role key must never reach a browser bundle. |
| `packages/review-worker` | `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_*` |
| `cli/` + `runtime/` | `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_*`, `COMPOSIO_*`, `TEMPORAL_*`, `CHANNEL_MODE` |

**Validate at startup, not at first use.** `packages/compiler/env.ts` and `runtime/env.py` each parse their required subset and exit naming the missing variable. A five-minute build that dies on iteration 3 because `COMPOSIO_API_KEY` was blank is the same lost hour as the auth wall block 0a exists to prevent.

**`ANTHROPIC_MODEL` is pinned deliberately.** Extraction runs through a model, so the eval suite's expected values are only meaningful against a fixed one. Swapping it mid-build changes fixture results with no code change and makes the heal loop's "failures strictly decreasing" halt condition meaningless.

---

## 4. `packages/compiler` — build this first

Everything else is downstream. Build it first and it de-risks the whole 48 hours.

```ts
type Finding = {
  code: FindingCode;                    // closed enum — shared by review, freeze, renderer
  severity: 'blocking' | 'advisory';
  anchor: { node_id: string } | { edge_id: string };   // exactly one — every diagnostic has a location
  evidence: Record<string, unknown>;    // the facts that fired it
  mutation: Mutation;                   // built here, never by the model
};

type IR = {
  edge_roles: Record<EdgeId, 'derive'|'read'|'input'|'outcome'|'contain'|'join'|'merge'>;
  topo_order: NodeId[];                 // fail edges stripped
  loop_scopes: Record<NodeId, NodeId[]>;// which `many` edges wrap this node
  verdict_targets: Record<PolicyId, NodeId>;
  fail_handlers: FailEdge[];            // -> Temporal signal handlers
  identity_merges: Record<NodeId, string>;
};

elaborate(nodes, edges): { ir: Partial<IR>, findings: Finding[] }
```

> **"Kind" is gone entirely.** It used to mean three things — `nodes.kind` (the primitive), `config.kind` (a policy's check type), and `IR.edge_kinds` (an edge's resolved role). The column is now `nodes.primitive`, the IR field is `edge_roles`, and policies no longer carry a `kind` at all: they carry a `describes` she wrote and a `check` or `impl` the agent resolved it to. One fewer overloaded word, and the one that was hardest to explain to a non-engineer.

### `registry.json` has three sections

`kinds` is what's required, `ask` is how it's elicited, `templates` is what codegen reads. One file, three consumers, and a CI test that ties them together.

```jsonc
{ "registry_version": "1.0",
  "kinds":     { "<kind>": { required, required_if, optional, defaults, enums } },
  "ask":       { "<kind>.<key>": { binding, options_from, extensible, closed_because, intent } },
  "templates": { "<kind>.<name>": { reads: ["<key>", ...] } } }
```

**The file is written out in full in §5.1** — this section explains the three mechanisms it encodes.

**`binding` is the ambiguity firewall.** Three values, and this single mechanism is what keeps unvalidated free text out of control flow:

- `control` — drives branching, looping or targeting in generated code. Must be answered from a computed option set. Renders as a picker.
- `prompt` — the value's only destination is an LLM extraction prompt. Free text is fine; a bad value produces a bad extraction, not bad control flow.
- `derived` — she never types it and never picks it. The agent resolved it from something she wrote, plays it back in her own field names, and she confirms or rejects. `policy.check`, `policy.impl` and `policy.reads` are the only `derived` keys, and confirmation is what makes them safe to compile.

`source_hint` is prose because it goes into a prompt. `pair_on` is a picker because it goes into a `for` loop. She cannot type "the batch thingy" into anything that compiles.

**`comments.answer_kind` is derived from `binding`, never chosen:** `control → choice`, `derived → choice` (confirm or reject), `prompt → text`. Three bindings collapse to two answer kinds, which is why the README's `answer_kind` column stays exactly as specified instead of becoming a UI detail.

**`intent` is optional.** When absent, `render()` gives the model the finding code, the condition name that fired, and the template name that reads the key — all machine-derived and already meaningful English. Add an `intent` override only when generated wording reads badly to a non-technical user. The per-key cost of adding a registry key is therefore one word: its binding.

### `options_from` — computed, never invented

Implemented in code, keyed by name, same pattern as the `required_if` conditions:

```ts
export const optionSources = {
  own_fields:  (n)        => n.config.fields ?? [],
  enum:        (n, g, key) => registry.kinds[n.primitive].enums[key],
  shared_fields_of_inbound_artifacts: (n, g) =>
    intersect(g.inboundArtifacts(n.id).map(p => p.config.fields ?? [])),
  inbound_artifact_nodes: (n, g) =>
    g.inboundArtifacts(n.id).map(p => ({ value: p.id, label: p.label })),
  shared_fields_of_endpoints: (e, g) =>
    intersect([g.node(e.from), g.node(e.to)].map(x => x.config.fields ?? [])),
  read_artifact_fields: (n, g) =>
    unique(g.inboundArtifacts(n.id).flatMap(p => p.config.fields ?? [])),
  upstream_artifacts_of_policy: (e, g) =>
    g.inboundArtifacts(e.from).map(p => ({ value: p.id, label: p.label })),
  transport_registry: () => runtimeChannelRegistry.keys(),
};
```

Options are computed **before** the model call. The model relabels them into plain English; it never produces a value. It can't hallucinate an anchor either, because `render()` doesn't hand it the anchor field.

Two rules that fall out and need stating:

- **`extensible: true` appends an "Something else — describe it" option; `extensible: false` does not.** A closed enum instead renders `closed_because` as a redirect, so the dead end becomes a different question.
- **An empty computed option set is itself a finding, never an empty dropdown.** If `shared_fields_of_inbound_artifacts` returns `[]`, the parents share no field, so no pairing rule can exist — that's a `missing_field` on the parents, and it must fire *before* the `pair_on` question is askable. Same for `inbound_artifact_nodes` on an unbound policy. Ordering matters: the precondition finding outranks the key it unblocks.

### The CI test that makes the central claim true

```ts
// Two manifests, one rule. Templates name what codegen reads; reads_compiler
// names what elaborate() consumes to build `compiled`.
function* everyReadKey(): Generator<[string, string]> {
  for (const [name, tpl] of Object.entries(reg.templates))
    for (const key of tpl.reads) yield [name.split(".")[0], key];
  for (const ref of reg.reads_compiler)
    yield ref.split(".") as [string, string];
}

test("every key anything downstream reads is askable or defaulted", () => {
  for (const [primitive, key] of everyReadKey()) {
    const k = reg.kinds[primitive];
    const conditional = Object.values(k.required_if ?? {}).flat();
    const isRequired = k.required.includes(key) || conditional.includes(key);
    expect(isRequired || (k.optional ?? []).includes(key)).toBe(true);
    if (isRequired) expect(reg.ask[`${primitive}.${key}`]?.binding).toBeDefined();
    else            expect(k.defaults?.[key]).toBeDefined();   // optional keys need a default
  }
});
```

Adding a template — or a compiler-consumed key — that nobody can ask about fails CI. Freeze passing is then *equivalent* to "every key anything downstream reads is bound or defaulted" — by construction, not by assertion. This is the tightest statement of the thesis in the whole build, and it's twenty lines.

> **Three gaps found by writing the test out, each fixed above.** Optional keys read by a template need a declared **default**, or an unanswered optional key reaches codegen undefined. `edge.*` ask entries require a `kinds.edge` block, which the README's registry leaves implicit. And covering only `templates` left a whole class unverified: `rel`, `on`, `cardinality`, `identity_key` and `verdict_on` are consumed by `elaborate()` to build `compiled`, never named by a template, so a future key of that shape could ship with no `ask` entry and the build would stay green. Hence `reads_compiler`.
>
> Extending the test immediately caught one: **`edge.rel` was in no list at all** — not `required`, not `required_if`, not `optional` — so the first compiler-read key would have failed. It's now `required_if: endpoints_are_artifacts`, which is also the semantically right home: `rel` means nothing on a channel→artifact edge.

### Four tiers of config key

Not every key extends the same way, and the registry should say which is which. This is the principled answer to "why can't I extend that one," rather than "because I hardcoded it."

| Tier | Keys | Options come from | "Something else" means |
|---|---|---|---|
| **Graph-derived** | `verdict_on`, `pair_on`, `identity_key`, edge `on` | her own board | Cannot happen. A value not in the list means she needs another *edge*. The option set grows when the graph grows. |
| **Semantic enum** | `output.fn`, `channel.tool` | registry enums | Each value maps to a template + runtime verb. `extensible: true` → the option set gains "something else". |
| **Elicited & compiled** | `policy.check`, `policy.impl` | her description, resolved by the agent | Not a tier she picks from at all. Ten relations cover most; anything else becomes an `impl` written at review time, gated and confirmed. She is never blocked and never sees the word "relation". |
| **Control-flow enum** | `on_fail`, `cardinality` | registry enums | `extensible: false`. Closed by the execution model. The comment redirects using `closed_because`. |

The line between the semantic and control-flow enums: **does a new value need a new verb, or a new orchestrator?** New verb → ten lines, ships to everyone. New orchestrator → different product.

The policy row is why the table has four rows and not three: a check isn't picked from a list *or* derived from the graph — it's described and compiled. That's the one place this system elicits judgment rather than structure.

`on_fail` is the one that looks extensible and isn't. It doesn't name a check; it names what the orchestrator does with a failing record, and a linear run over `topo_order` can do exactly two things. "Retry three times, then escalate" is not a third `on_fail` — it's the fail edge, which already has `max_attempts`, `timeout` and `on_exhausted`. So the correct response is a `missing_node` proposal drawing the outbound channel. `closed_because` is what lets `render()` produce that redirect instead of a dead end.

### `pairs_with` is symmetric; its direction is an execution hint

The first question any reviewer asks about the join edge, so answer it in the document rather than in the Q&A.

**A `pairs_with` edge makes no claim about the domain.** `from` is the node that gets iterated, `to` is the one looked up:

```python
for batch in batches:
    batch.cert = lookup(certs, on="batch_number")
```

Draw it the other way and you get an equivalent agent with the loops inverted. Both directions freeze; neither is wrong. Contrast `contains`, which *is* asymmetric — a Good extracted from an Invoice cannot be reversed — and `builds_from`, where the parents are named by in-degree.

That sets the wording of the question too. `render()` asks **"these two records pair up — which field connects them?"**, not "which one contains the other," because the second implies an asymmetry that isn't there and invites her to agonise over a choice that doesn't matter.

**Why `rel` is declared rather than inferred.** The obvious alternative derives meaning from key presence — no `on` means containment, `on` means a pair. In-degree for `builds_from` is safe, but that discriminator isn't: draw Batch → Certificate meaning *pair these*, leave `on` unset, and the compiler reads containment and emits code extracting certificates out of batches. A **silently wrong compile** is the exact failure class this design exists to prevent, and it would only be caught in the narrow case where both artifacts happen to share an `identity_key`. One enum key and one question at edge-creation time buys the whole class away.

> This is also why the rename earns its keep. `matches` reads like a verdict, and the edge produces no verdict — it's a lookup that runs *before* any check. The policy is what decides pass or fail. Same reason the ten relations are named for what they assert (`exists_matching`, not `cross_reference`), and cheap while no templates exist.

### Finding codes

**Blocking, decided in code (Pass A) — these *are* the freeze predicates:**

| Code | Fires when |
|---|---|
| `missing_required_key` | registry `required` key absent |
| `missing_conditional_key` | a `required_if` condition fired and its key is absent — `pair_on`, `verdict_on`, `identity_key`, `source_hint`, `match`, `request`, `rel`, `on` |
| `invalid_enum_value` | value outside registry `enums` |
| `unreachable_node` | not reachable from any channel |
| `no_terminal_path` | reaches no output and no outbound channel |
| `data_cycle` | cycle survives after fail-edge stripping |
| `unbound_policy` | policy with no inbound artifact edge |
| `output_row_unresolvable` | row references unknown node/field, or `copy` across a `many` edge |
| `undeclared_join` | two artifacts share an `identity_key`, no join edge between them |
| `unresolved_policy` | her description hasn't resolved to a `check` or an `impl` yet (below) |
| `reads_unbound` | a `reads` path names an artifact with no edge into this policy |
| `open_comment` | any comment not `resolved`/`rejected` |

### Policies are described, not picked — and compiled at review time

She names the policy and describes the check in her own words. There is no enum to choose from and no vocabulary to learn. The review agent clarifies the description against the fields on her inbound artifacts until the ambiguity is gone, resolves it to one of two shapes, plays it back **in her field names**, and she confirms.

**No LLM runs at execution time on either path.** Both resolve to Python before the hash.

**Shape one — `check`, compiled to a known relation.** Ten ship, one template each:

```
present   absent   exists_matching   equals      in_set
within    older_than   newer_than    greater_than   less_than
```

```jsonc
"config": {
  "describes": "every batch on the invoice needs a certificate of analysis",
  "check": { "relation": "exists_matching", "params": { "on": "batch_number" } },
  "reads": ["rec_batch.batch_number", "rec_coa.batch_number"],
  "verdict_on": "rec_batch", "on_fail": "flag_and_continue", "on_absent": "fail",
  "confirmed_by": "c_07"
}
```

`reads` supplies the operands positionally; `params` carries whatever else the relation needs — `on` for a lookup, a threshold for a window, a set for membership.

**Shape two — `impl`, when no relation fits.** The agent writes the function and it is **frozen into the spec**. Codegen pastes it verbatim, so the same spec produces byte-identical code and `spec_hash` still means what it claims:

```jsonc
"config": {
  "describes": "payment must clear within 30 days of the invoice date",
  "impl": {
    "signature": ["rec_payment.cleared_date", "rec_inv.invoice_date"],
    "reads_fields": ["rec_payment.cleared_date", "rec_inv.invoice_date"],
    "helpers": ["days_between"],
    "body": "def check(cleared_date, invoice_date):\n    return days_between(invoice_date, cleared_date) <= 30\n"
  },
  "reads": ["rec_payment.cleared_date", "rec_inv.invoice_date"],
  "verdict_on": "rec_inv", "on_fail": "flag_and_continue", "on_absent": "fail",
  "confirmed_by": "c_11"
}
```

**Three gates on `impl`,** because this is the one place a model's prose becomes executable logic:

1. **Declared surface.** The agent must emit `signature`, `reads_fields` and `helpers` alongside the body — not as documentation, as a contract.
2. **AST validator.** Rejects any body that touches an undeclared field, calls an unlisted helper, or imports anything. `signature` must equal `reads`, so the function can't quietly widen what it looks at.
3. **Human sign-off.** `confirmed_by` points at a comment that stays `open` until she confirms — and `open_comment` already blocks freeze, so no new predicate is needed.

**Both paths carry the same six keys:** `describes`, `reads`, `verdict_on`, `on_fail`, `on_absent`, `confirmed_by`. `on_absent` is `pass | fail` and fires when any field the check reads is empty, so codegen guards both paths identically — the difference between the shapes is what runs *after* the guard, never around it.

**Unresolved falls out of `required_if`, not a bespoke check.** `neither_resolved` fires exactly when both `check` and `impl` are absent, requires `check`, and the absence emits a finding — the same mechanism as every other missing key, no new code path in `elaborate()`. Once either shape resolves, the condition goes false and the matching `resolved_to_*` entry takes over.

Two notes on making that read correctly:

- **The listed key is `check`, but `impl` satisfies it equally.** `required_if` has no "one of" grammar, so the entry names one key to force the finding. Left bare it would imply a relation is mandatory, which is the opposite of the design — hence `required_if_codes`, which lets the condition name its own finding code so the freeze error says `unresolved_policy: pol_pay` rather than `missing_conditional_key: check`.
- **A missing `derived` key is work for the agent, not a question for her.** This is the routing rule that keeps the whole thing coherent: a missing `control` or `prompt` key becomes a comment she answers; a missing `derived` key means the agent hasn't resolved her description yet, so it goes back and resolves. She never sees a question asking which relation to use, because that question is never hers to answer.

**When neither resolves, `unresolved_policy` blocks freeze.** Not "we can't build this yet" — the agent simply hasn't got enough from her to choose a shape, so it asks again. The `impl` escape hatch means the only way to stay unresolved is genuine ambiguity in the description, which is exactly what more rounds are for.

> **This grants the review agent real authority, and it's worth being straight about that.** It now writes Python, where before it only proposed structure. The defence isn't that the model is trustworthy — it's that `impl` gets strictly *less* latitude than the codegen agent already has: a declared surface, an AST validator that rejects imports and undeclared reads, a signature that must equal `reads`, and a human who signs off before freeze. And it runs once, at review time, into an immutable artifact — not per record at execution.
>
> The trade against the old enum-plus-promotion design: that one made her wait for an engineer, and in exchange the platform learned a new relation everyone got. This one never blocks her, and the learning becomes a *mining* problem instead — recurring `impl` bodies are the shortlist for relation eleven. Better product, weaker flywheel, and the flywheel is recoverable later.

**One conflict to settle during the build.** `on_absent` fires when a read field is empty, but `present` and `absent` are *about* emptiness — `present` with `on_absent: pass` says a missing field both passes the guard and fails the relation. Recommendation: the guard runs first for comparison relations only; for `present`/`absent` the relation subsumes it, and `elaborate()` emits an advisory when the two contradict. Cheap to implement, and it stops a nonsense combination reaching codegen.

**Advisory, decided in code — structural correction:** `demote_to_field`, `compression`, `dead_node`. Ranked *above* most missing-key questions, per the README's reasoning: fixing a modeling mistake in round one means round two isn't asking five questions about five nodes that shouldn't exist.

**Pass B may only propose:** `missing_node`, `missing_edge`, `missing_field`, `cardinality`, `lifecycle`.

> Note this shrinks the model's set from the README's eleven codes. `undeclared_join`, `missing_pairing`, `dead_node`, `demote_to_field` and `compression` are all *decidable*, so they belong to the compiler. The model never gets to claim something code could have decided.

### Mutations

Closed set, each with an applier: `set_config_key`, `add_node`, `add_edge`, `set_edge_config`, `demote_to_field` (with `rewire_policies`), `merge_nodes`, `delete_node`, `add_output_row`.

Each applies in one transaction that also flips its comment to `resolved`. **No inverses, no event log** — nothing in the canvas is undone, so reversibility would be machinery paying for a capability the product doesn't have.

Provenance survives that intact, because it never lived in the event log: `comments` holds the mutation, the answer, the author and the round, and `frozen_specs.provenance.comments` lists the IDs that shaped the spec. "Six months on, every structural choice traces to a question, an answer, and a name" is a join across two tables. `supersedes` still works too — it marks that a later decision replaced an earlier one, which is a thread annotation, not a rollback.

### Freeze

`freeze()` = no blocking findings → `canonical()` (sort keys, drop `x`, `y`, `updated_at`; **keep `label`** — it reaches the extraction prompt, so a label change changes behaviour and must change the build ID) → `sha256` → write `frozen_specs` row with `spec.compiled = ir` → set `process_maps.status='frozen'`. Failure returns the offending node IDs.

**Test strategy:** one fixture board per finding code — written with synthetic IDs (`a1`, `p1`, `o1`), never pharma ones, so the tests can't encode a domain. Then a golden test per `examples/` board — receiving and loan-file both elaborate to zero blocking findings and hash stably. Same compiler, two industries, one assertion.

---

## 5. The three concrete artifacts

Everything above is a claim about these three files. Written out in full so the build has something to type against, and so a reviewer can check the claims rather than take them.

### 5.1 `packages/compiler/registry.json`

```jsonc
{
  "registry_version": "1.0",

  // ── what's required ────────────────────────────────────────────────
  // indexed by node.primitive, plus the literal "edge". The section keeps the
  // name `kinds` because it spans nodes and edges; the node column is
  // `primitive`, and policies carry no `kind` at all.
  "kinds": {
    "channel": {
      "required": ["tool"],
      "required_if": { "has_outputs": ["match"], "has_inputs": ["request"] },
      "optional": [],
      "defaults": {},
      "enums": { "tool": "@transport_registry" }        // resolved at load from runtime
    },

    "artifact": {
      "required": ["fields"],
      "required_if": {
        "multiple_sources":                    ["identity_key"],
        "multiple_inbound_artifacts":          ["pair_on"],
        "sibling_artifacts_from_same_channel": ["source_hint"]
      },
      "optional": ["computed", "extraction_hint"],
      "defaults": { "computed": null, "extraction_hint": null }
    },

    "policy": {
      // She describes the check in her own words. `check` or `impl` is what
      // the review agent resolved that description to, and she confirmed.
      "required": ["describes", "on_fail", "on_absent"],
      "required_if": {
        "resolved_to_relation": ["check", "reads", "confirmed_by"],
        "resolved_to_impl":     ["impl",  "reads", "confirmed_by"],
        "neither_resolved":     ["check"],        // fires unresolved_policy
        "multiple_read_artifacts": ["verdict_on"]
      },
      "optional": [],
      "defaults": {},
      "enums": {
        "relation":  ["present", "absent", "exists_matching", "equals", "in_set",
                      "greater_than", "less_than", "within", "older_than", "newer_than"],
        "on_fail":   ["halt", "flag_and_continue"],
        "on_absent": ["pass", "fail"]
      }
    },

    "output": {
      "required": ["rows"],
      "optional": [],
      "defaults": {},
      "enums": { "fn": ["count", "sum", "list", "copy", "verdict"] }
    },

    // `edge` must be a kind, not an implicit thing — the ask entries below
    // reference it, and the askable-or-defaulted test indexes kinds by name.
    "edge": {
      "required": [],
      // `rel` only means anything on an artifact->artifact edge, hence required_if
      "required_if": { "endpoints_are_artifacts": ["rel"],
                       "rel_is_pairs_with":       ["on"] },
      "optional": ["cardinality", "await", "rescope",
                   "max_attempts", "timeout", "on_exhausted"],
      "defaults": { "cardinality": "one", "max_attempts": 1,
                    "timeout": null, "on_exhausted": "escalate" },
      "enums": {
        "cardinality":  ["one", "many"],
        "rel":          ["contains", "pairs_with", "builds_from"], // declared, not inferred
        "on_exhausted": ["escalate", "halt", "continue"],
        "timeout":      ["PT30S", "PT1H", "P1D", "P5D", "P14D"],
        "max_attempts": [1, 2, 3, 5]
      }
    }
  },

  // A condition may name the finding code it emits. Default is
  // `missing_conditional_key`; naming one gives a legible freeze error.
  "required_if_codes": { "neither_resolved": "unresolved_policy" },

  // ── how it's elicited ──────────────────────────────────────────────
  // binding is the ambiguity firewall. control -> picker over a computed
  // option set. prompt -> free text whose only destination is an LLM prompt.
  "ask": {
    "channel.tool":          { "binding": "control", "options_from": "transport_registry",
                               "extensible": true },
    "channel.match":         { "binding": "prompt",
                               "intent": "how to recognise the messages that belong to this process" },
    "channel.request":       { "binding": "prompt",
                               "intent": "what gets sent out, and what goes in it" },

    "artifact.fields":       { "binding": "prompt",
                               "intent": "the values pulled out of this thing" },
    "artifact.source_hint":  { "binding": "prompt",
                               "intent": "which part of the message this one comes from" },
    "artifact.identity_key": { "binding": "control", "options_from": "own_fields" },
    "artifact.pair_on":      { "binding": "control",
                               "options_from": "shared_fields_of_inbound_artifacts" },

    "policy.describes":      { "binding": "prompt",
                               "intent": "what this check looks at, in your own words" },
    "policy.check":          { "binding": "derived",
                               "intent": "played back in her field names for confirmation" },
    "policy.impl":           { "binding": "derived",
                               "intent": "played back in her field names for confirmation" },
    "policy.reads":          { "binding": "derived", "multi": true,
                               "options_from": "read_artifact_fields" },
    "policy.verdict_on":     { "binding": "control", "options_from": "inbound_artifact_nodes" },
    "policy.on_fail":        { "binding": "control", "options_from": "enum",
                               "extensible": false,
                               "closed_because": "the orchestrator can stop or continue; a third behaviour is a fail edge, not an enum value" },
    "policy.on_absent":      { "binding": "control", "options_from": "enum",
                               "extensible": false,
                               "closed_because": "a check whose input is empty either passes or fails; there is no third answer" },
    "policy.confirmed_by":   { "binding": "derived",
                               "intent": "the comment where she signed this check off" },

    "output.rows":           { "binding": "control", "options_from": "resolvable_row_targets",
                               "multi": true },

    "edge.rel":              { "binding": "control", "options_from": "enum", "extensible": false,
                               "intent": "how these two records relate — one sits inside the other, they pair up, or one is built from several",
                               "closed_because": "one record can sit inside another, pair with another, or be built from several — the compiler has no fourth shape" },
    "edge.on":               { "binding": "control", "options_from": "shared_fields_of_endpoints" },
    "edge.cardinality":      { "binding": "control", "options_from": "enum", "extensible": false,
                               "closed_because": "a step runs once or loops; there is no third arity" },

    "edge.on_exhausted":     { "binding": "control", "options_from": "enum", "extensible": false,
                               "closed_because": "when the wait runs out the run can escalate, stop, or carry on with what it has" },
    "edge.timeout":          { "binding": "control", "options_from": "enum", "extensible": false,
                               "closed_because": "a fixed set of wait durations; a custom value is an implementer edit, not a question" },
    "edge.max_attempts":     { "binding": "control", "options_from": "enum", "extensible": false,
                               "closed_because": "chase counts beyond a handful mean the process needs a different escalation, not a bigger number" },
    "edge.rescope":          { "binding": "control", "options_from": "upstream_artifacts_of_policy",
                               "multi": true }
  },

  // ── what codegen reads ─────────────────────────────────────────────
  // `reads` is the contract the CI test enforces against kinds + ask.
  "templates": {
    "channel.inbound":         { "reads": ["tool", "match"] },
    "channel.outbound":        { "reads": ["tool", "request"] },   // request carries to/subject/body
    "artifact.extract":        { "reads": ["fields", "source_hint", "extraction_hint"] },
    "artifact.identity":       { "reads": ["identity_key"] },
    "artifact.merge":          { "reads": ["pair_on"] },
    "policy.relation":         { "reads": ["describes", "check", "reads",
                                           "on_fail", "on_absent", "verdict_on"] },
    "policy.impl":             { "reads": ["describes", "impl", "reads",
                                           "on_fail", "on_absent", "verdict_on"] },
    "output.rows":             { "reads": ["rows"] },
    "edge.loop":               { "reads": ["cardinality"] },
    "edge.join":               { "reads": ["on"] },
    "edge.fail":               { "reads": ["await", "rescope", "max_attempts",
                                           "timeout", "on_exhausted"] }
  },

  // ── what the compiler reads ────────────────────────────────────────
  // Keys elaborate() consumes to build `compiled`, which codegen then reads
  // instead of the raw key. No template names them, so without this manifest
  // they'd escape the askable-or-defaulted test entirely.
  "reads_compiler": ["edge.rel", "edge.on", "edge.cardinality",
                     "artifact.identity_key", "policy.verdict_on",
                     "policy.confirmed_by"]
}
```

Conditions (`has_outputs`, `multiple_reads`, `rel_is_pairs_with`, …) and option sources (`own_fields`, `shared_fields_of_endpoints`, …) are functions in code keyed by these names — the JSON names them, it never expresses them. That's what keeps the registry free of both target-language syntax and graph-traversal logic.

### 5.2 A frozen spec, in full

Domain nouns are legal here — this is a `processes/` artifact, not a system file. Note `registry_version`, and the `compiled` block that freeze writes and codegen reads.

```jsonc
{
  "spec_version": "1.0",
  "registry_version": "1.0",
  "process_id": "shipment_receiving_001",
  "spec_hash": "sha256:7c1e…9b4f",

  "nodes": [
    { "id": "ch_a1", "primitive": "channel", "label": "Pre-alert inbox",
      "config": { "tool": "composio.gmail",
                  "match": { "subject_patterns": ["Pre-Alert Documents"] } } },

    { "id": "rec_inv", "primitive": "artifact", "label": "Commercial invoice",
      "config": { "identity_key": "invoice_number",
                  "fields": ["invoice_number", "container_no"],
                  "source_hint": "attachment headed 'Commercial Invoice'" } },

    { "id": "rec_good", "primitive": "artifact", "label": "Good",
      "config": { "fields": ["hts", "fda_product_code", "anda", "reg_no", "ndc"] } },

    { "id": "rec_batch", "primitive": "artifact", "label": "Batch",
      "config": { "identity_key": "batch_number", "fields": ["batch_number"] } },

    { "id": "rec_coa", "primitive": "artifact", "label": "Certificate of analysis",
      "config": { "identity_key": "batch_number", "fields": ["batch_number"],
                  "source_hint": "attachment headed 'Certificate of Analysis'" } },

    { "id": "rule_fields", "primitive": "policy", "label": "Required fields present",
      "config": { "describes": "each good has to carry all five regulatory codes",
                  "check": { "relation": "present" },
                  "reads": ["rec_good.hts", "rec_good.fda_product_code",
                            "rec_good.anda", "rec_good.reg_no", "rec_good.ndc"],
                  "verdict_on": "rec_good",
                  "on_fail": "flag_and_continue", "on_absent": "fail",
                  "confirmed_by": "c_04" } },

    { "id": "rule_coa", "primitive": "policy", "label": "Batch has certificate",
      "config": { "describes": "every batch on the invoice needs a certificate of analysis",
                  "check": { "relation": "exists_matching",
                             "params": { "on": "batch_number" } },
                  "reads": ["rec_batch.batch_number", "rec_coa.batch_number"],
                  "verdict_on": "rec_batch",
                  "on_fail": "flag_and_continue", "on_absent": "fail",
                  "confirmed_by": "c_07" } },

    { "id": "ch_out", "primitive": "channel", "label": "Discrepancy email",
      "config": { "tool": "composio.gmail",
                  "request": { "to": "danieljhsiao@gmail.com",
                               "subject": "Discrepancy — invoice {rec_inv.invoice_number}",
                               "body": "Missing certificates for: {rec_batch.batch_number where fail}" } } },

    { "id": "out_res", "primitive": "output", "label": "Shipment result",
      "config": { "rows": [
        { "label": "invoices_processed", "fn": "count", "of": "rec_inv" },
        { "label": "invoices_failed",    "fn": "count", "of": "rec_inv",   "where": "fail" },
        { "label": "goods_failed",       "fn": "count", "of": "rec_good",  "where": "fail" },
        { "label": "batches_processed",  "fn": "count", "of": "rec_batch" },
        { "label": "batches_failed",     "fn": "count", "of": "rec_batch", "where": "fail" },
        { "label": "failed_batch_ids",   "fn": "list",
          "of": "rec_batch.batch_number", "where": "fail" }
      ] } }
  ],

  "edges": [
    { "id": "e1",  "from": "ch_a1",     "to": "rec_inv",     "config": { "cardinality": "many" } },
    { "id": "e2",  "from": "ch_a1",     "to": "rec_coa",     "config": { "cardinality": "many" } },
    { "id": "e3",  "from": "rec_inv",   "to": "rec_good",    "config": { "rel": "contains", "cardinality": "many" } },
    { "id": "e4",  "from": "rec_inv",   "to": "rec_batch",   "config": { "rel": "contains", "cardinality": "many" } },
    { "id": "e5",  "from": "rec_batch", "to": "rec_coa",     "config": { "rel": "pairs_with", "on": "batch_number" } },   // `on` = join key
    { "id": "e6",  "from": "rec_good",  "to": "rule_fields", "config": {} },
    { "id": "e7",  "from": "rec_batch", "to": "rule_coa",    "config": {} },
    { "id": "e8",  "from": "rec_coa",   "to": "rule_coa",    "config": {} },
    { "id": "e9",  "from": "rule_fields","to": "out_res",    "config": {} },
    { "id": "e10", "from": "rule_coa",  "to": "out_res",     "config": {} },
    { "id": "e11", "from": "rule_coa",  "to": "ch_out",
      "config": { "on": "fail",                    // `on` = trigger literal, not a field

                  "await": { "channel": "ch_a1", "correlate_on": "invoice_number" },
                  "rescope": ["rec_batch"], "max_attempts": 3,
                  // DEMO VALUE — production is "P5D". Shortened so the run parks
                  // visibly and falls through on camera. Not a typo for five days.
                  "timeout": "PT30S", "on_exhausted": "continue" } }
  ],

  // ── written by freeze(), read by codegen, re-derived by nobody ──────
  "compiled": {
    "edge_roles": {
      "e1": "derive",  "e2": "derive",  "e3": "contain", "e4": "contain",
      "e5": "join",    "e6": "read",    "e7": "read",    "e8": "read",
      "e9": "outcome", "e10": "outcome","e11": "fail"
    },
    "topo_order": ["ch_a1", "rec_inv", "rec_good", "rec_batch",
                   "rec_coa", "rule_fields", "rule_coa", "out_res"],
    "loop_scopes": {
      "rec_inv":     ["e1"],
      "rec_coa":     ["e2"],
      "rec_good":    ["e1", "e3"],
      "rec_batch":   ["e1", "e4"],
      "rule_fields": ["e1", "e3"],
      "rule_coa":    ["e1", "e4"]
    },
    "verdict_targets": { "rule_fields": "rec_good", "rule_coa": "rec_batch" },
    "identity_merges": { "rec_inv": "invoice_number", "rec_batch": "batch_number",
                         "rec_coa": "batch_number" },
    "joins": [ { "edge": "e5", "left": "rec_batch", "right": "rec_coa", "on": "batch_number" } ],
    "fail_handlers": [
      { "edge": "e11", "signal": "reply_received", "from": "rule_coa", "to": "ch_out",
        "await": { "channel": "ch_a1", "correlate_on": "invoice_number" },
        "rescope_order": ["rec_batch", "rule_coa"],
        "max_attempts": 3, "timeout": "PT30S", "on_exhausted": "continue" }
    ]
  },

  "provenance": {
    "comments": ["c_01", "c_02", "c_04", "c_08"],
    "assumptions": [
      { "id": "c_03", "applies_to": "rule_fields.reads",
        "text": "five regulatory codes; operator notes over the older four-field list" }
    ]
  }
}
```

Four things to notice, because each one is a claim being cashed:

- **`compiled.topo_order` excludes `ch_out`.** It's reachable only through a fail edge, so it isn't in the data DAG — it's in `fail_handlers`. Reachability (predicate 1) traverses fail edges; cycle detection (predicate 3) does not. Those are different traversals over the same graph and the implementation must not share one visited-set.
- **`loop_scopes` is edge IDs, not node IDs.** Codegen needs to know *which* `many` edge it's nested inside to emit the right iterator variable, and two `many` edges from one parent are distinguishable only by edge.
- **`config.on` means two things, disambiguated by endpoint primitives.** On an artifact→artifact edge it's the **join key** — `e5`'s `"batch_number"`, a field name, declared in the registry as `required_if: rel_is_pairs_with`. On a policy→channel edge it's the **trigger literal** — `e11`'s `"fail"`, a verdict. `elaborate()` branches on the endpoint primitives *before* reading the key, and `templates["edge.join"]` only ever sees artifact→artifact edges, so the two never meet in one code path.

  Two consequences worth being explicit about. First, the trigger meaning is not elicited: today `"fail"` is its only value, set by the mutation that draws the edge, so it's a compiler-set marker rather than a question — which is why it appears in no `ask` entry and no manifest. Second, that's exactly the shape of gap `reads_compiler` exists to catch, and it's tolerable *only* while the value set has one member.

  **The moment a success path appears** — a policy→channel edge firing on `pass`, say a notification on clean receipt — split the trigger into its own key `fires_on` with a `pass | fail` enum and an `ask` entry, rather than overloading `on` further. One key with two meanings survives because the endpoints disambiguate it; one key with two meanings *and* two values in each is where a silently wrong compile gets in.

- **`provenance.assumptions` is what becomes `# assumption c_03` in generated code**, and what `heal_guard` greps for. It's the mechanism that keeps a decision the type system *can't* make — which of two conflicting source documents governs — from being silently eroded by the self-heal loop.

### 5.3 Table schema

Where this differs from the README's schema, the comment says why. Everything else is unchanged.

```sql
create table users (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null,
  email      text not null unique,
  created_at timestamptz not null default now()
);

create table process_maps (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null,
  title      text not null,
  status     text not null default 'draft'
             check (status in ('draft','frozen')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Node ids are human-readable and board-local ('rec_inv'), so a global
-- primary key collides the moment a second board uses the same id.
create table nodes (
  map_id     uuid not null references process_maps(id) on delete cascade,
  id         text not null,                      -- 'rec_inv', never from label
  primitive  text not null                       -- renamed from `kind` (now unambiguous)
             check (primitive in ('channel','artifact','policy','output')),
  label      text not null,                      -- IS read: reaches the extraction prompt
  config     jsonb not null default '{}',
  x          int not null default 0,             -- stripped before hashing
  y          int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (map_id, id)
);

create table edges (
  map_id    uuid not null references process_maps(id) on delete cascade,
  id        text not null,
  from_node text not null,
  to_node   text not null,
  config    jsonb not null default '{}',
  primary key (map_id, id),
  foreign key (map_id, from_node) references nodes(map_id, id) on delete cascade,
  foreign key (map_id, to_node)   references nodes(map_id, id) on delete cascade,
  unique (map_id, from_node, to_node)            -- was global; now per-board
);
create index on edges (map_id, to_node);         -- badge counts, in-degree

create table review_runs (
  id         text primary key,
  map_id     uuid not null references process_maps(id) on delete cascade,
  round      int not null,
  status     text not null default 'queued'
             check (status in ('queued','running','done','failed')),
  created_at timestamptz not null default now()
);

create table comments (
  map_id      uuid not null references process_maps(id) on delete cascade,
  id          text not null,                     -- 'c_08'
  node_id     text,
  edge_id     text,
  parent_id   text,                              -- follow-up in thread
  supersedes  text,                              -- invalidates an earlier resolution
  round       int not null,
  run_id      text references review_runs(id),

  code        text not null,                     -- the Finding code, was comment_type
  severity    text not null
              check (severity in ('precondition','blocking','advisory')),
  pass        text not null check (pass in ('A','B')),
  binding     text not null check (binding in ('control','prompt','derived')),
  answer_kind text not null check (answer_kind in ('choice','text')),

  author_type text not null check (author_type in ('agent','user')),
  author_id   uuid references users(id),
  body        text not null,
  options     jsonb,                             -- computed, then relabeled by the model
  answer      jsonb,
  proposal    jsonb,                             -- a `derived` key's resolution, awaiting confirmation
  mutation    jsonb not null,                    -- a comment without one is a note
  status      text not null default 'open'
              check (status in ('open','answered','rejected','resolved')),
  created_at  timestamptz not null default now(),

  primary key (map_id, id),
  foreign key (map_id, node_id) references nodes(map_id, id) on delete cascade,
  foreign key (map_id, edge_id) references edges(map_id, id) on delete cascade,
  foreign key (map_id, parent_id)  references comments(map_id, id),
  foreign key (map_id, supersedes) references comments(map_id, id),

  -- Exactly one anchor, never zero. A diagnostic detached from its
  -- location is the thing the whole pin model exists to avoid.
  constraint one_anchor check (num_nonnulls(node_id, edge_id) = 1),
  -- a control question with no option set is an empty dropdown; that state
  -- is a precondition finding, never a comment.
  constraint control_has_options check (binding <> 'control' or options is not null),
  -- answer_kind is derived from binding, never chosen
  constraint answer_kind_matches_binding check (
    (binding in ('control','derived') and answer_kind = 'choice') or
    (binding = 'prompt'               and answer_kind = 'text')
  ),
  -- a derived key must show her what it resolved to before she can confirm it
  constraint derived_has_proposal check (
    binding <> 'derived' or proposal is not null
  )
);
create index on comments (map_id, status);
create index on comments (map_id, round);

create table frozen_specs (
  id               uuid primary key default gen_random_uuid(),
  map_id           uuid not null references process_maps(id) on delete cascade,
  version          int not null,
  registry_version text not null,                -- new: additive registry bumps
  spec             jsonb not null,               -- includes .compiled
  spec_hash        text not null,
  created_at       timestamptz not null default now(),
  unique (map_id, version)
);

-- Many builds per spec (re-runs, heal iterations), so the board needs
-- an explicit "latest".
create table spec_builds (
  id           uuid primary key default gen_random_uuid(),
  spec_id      uuid not null references frozen_specs(id),
  status       text not null default 'submitted'
               check (status in ('submitted','generating','testing',
                                 'healing','built','failed')),
  iteration    int not null default 0,
  tests_passed int,
  tests_total  int,
  message      text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on spec_builds (spec_id, created_at desc);
```

`spec_builds` stays separate from `frozen_specs` for the README's reason: the frozen payload is immutable, so mutable build status lives elsewhere. That's how "the spec never silently changes" survives having a live status attached to it.

**Policy confirmation needs no fifth status.** `config.confirmed_by` points at the comment carrying the resolution; that comment sits `open` until she confirms, and `open_comment` already blocks freeze. So the sign-off gate is the predicate she already has — nothing new in the enum, nothing new in the predicate list.

**`proposal is not null` is what the confirm UI branches on.** It holds the resolved `check` or the `impl` body played back in her field names, which is the thing she's being asked to agree with. A status column couldn't carry that; this one does. Recurring `impl` bodies across boards are also the shortlist for relation eleven — the same column that gates one build is the demand signal for the next relation.

---

## 6. Canvas — `apps/web`

The canvas renders **primitives, not domains** — a card is a channel/artifact/policy/output, and every string on it comes from a row. No component branches on a label's content.

React Flow. Four primitives. The renderer folds what's obvious and draws what's surprising, exactly per the README's table (containment → indented row; single-read policy → row + badge; two-read policy → own box; join → labelled line; merge → drawn; fail edge → red line).

**Renderer invariant — folding is lossy, the spec is not.** Folding is a *view* concern only. Test: `frozenSpec.nodes.length === store.nodes.length` for a board where the canvas draws 30 nodes as 4 cards.

Comment pins anchor to a node or edge — exactly one, never zero. A `missing_node` proposal anchors to the parent it will attach to, which keeps "no diagnostic is detached from its location" literally true.

Answering a comment calls the mutation applier. The board changes because she answered, not because she dragged — this is the demo's most persuasive four seconds and deserves a visible transition on the affected nodes.

---

## 7. Review loop — `packages/review-worker`

Long-running Node process on `LISTEN review_runs`.

**Pass A — no model.** Calls `elaborate()`, takes `findings`, calls `render(finding)` to get body text + `answer_kind` + `options`, inserts comment rows carrying the finding's mutation verbatim. ~80% of comments. This is the whole thesis: these questions are not authored, they are what the compiler could not resolve.

**Pass B — model, proposals only.** Reads node labels, free-text notes and `source_hint`s. Constrained-output call restricted to the five proposal codes. Every proposal must carry a mutation that `mutations.ts` validates, or it is dropped before insert. Then — the load-bearing part — an applied Pass B proposal is re-elaborated, and any hole it opens becomes a Pass A question:

```
note: "chase up missing COAs"          (English, no structure)
  Pass B → missing_node(channel, outbound)
  applied → elaborate() → required_if.has_inputs fires
  Pass A → "What should the subject line say?"   ← the compiler's question
```

Pass B feeds the type checker. It can never bypass it.

**`render()` runs between both passes and the database.** It reads the finding's `ask` entry, computes the option set via `options_from`, derives `answer_kind` from `binding`, and only then calls the model — to relabel machine-computed options into her language. The model writes wording, never values. A `control` comment with an option the option-source didn't produce is dropped before insert, same as a comment with an invalid mutation.

**Per round:** cap 7 comments, ranked by what blocks freeze (precondition findings → blocking → structural correction → advisory), deduped on `(code, anchor)` against prior rounds. Two memory shapes: the `parent_id`/`supersedes` thread for humans, a one-line-per-resolved-mutation **decision log** for the model.

**Stop condition:** Pass A returns no blocking findings.

**Convergence, stated honestly.** "The required-key set is finite per node" does *not* bound the loop, because `missing_node` and `promote_to_node` add nodes, each bringing its own required keys. The real argument is narrower and true: only Pass B adds nodes, Pass B is capped at 7 per round and deduped on `(code, anchor)`, a human answers every one, and freeze needs only `blocking === 0` — not silence. Worth stating precisely; it's the lemma a sharp reviewer pokes first.

**Seed board:** the receiving process, deliberately drawn the way a domain expert would actually draw it — five separate boxes for the good's attributes, no `identity_key` on the invoice, no outbound channel, a note saying "chase up missing certificates". Round one collapses the five boxes with one `demote_to_field`; round two asks questions that only exist because the collapse happened. That is the README's "type checker interviews the author" made concrete and demoable.

**The policy resolution loop is the third thing the worker does**, and it's where most of the round-two value now lives. For each policy carrying a `describes` but no `check`/`impl`: read the fields on its inbound artifacts, ask whatever's needed to disambiguate, resolve to a relation or write an `impl`, then emit a `derived` comment whose `proposal` is the resolution **played back in her field names** — "fails when *Batch number* has no matching *Certificate of analysis*", never "`exists_matching` on `batch_number`". She confirms or rejects; rejection reopens with her correction as new input.

**Generality check on the loop itself:** run the same worker against the loan-file board with two required keys removed. It must produce the same *codes* against different nouns. If Pass A needs a single line of domain awareness to review a second process, the registry is wrong.

---

## 8. Runtime + Temporal — `runtime/`

Hand-written, noun-free, and — the part that has to hold — **it does not know what a process is**. No `process_id` parameter, no import from `processes/`, no Gmail assumption above the dispatch table. The enumerated verbs:

- `channels/base.py` — `Channel` protocol: `fetch() -> list[Payload]`, `send(payload)`. Nothing else.
- `channels/capture.py` — wraps any adapter and records `send()` to `processes/<id>/captured/` instead of delivering. Selected by run mode, not by the spec — the same frozen spec sends live in a demo run and captures under `cli eval`.
- `channels/registry.py` — `tool` string → adapter class. `composio.gmail` is the only row today; `http.get`, `upload`, `composio.slack` are rows tomorrow. **Adding a transport is one entry plus one file**, which is the concrete form of the README's "transports are a dispatch table."
- `extract.py` — assembles an extraction prompt from `{label, fields, source_hint}` and a payload. The *only* place an LLM touches business data, and it reads that data out of the spec rather than knowing any of it.
- `identity.py` — `merge_by_identity_key()`. **Explicit rule: last-write-wins on field collision, union on absent.** Merging the same invoice arriving in two emails *is* conflict resolution, and codegen can't emit `identity.py` until the rule is written down.
- `relations.py` — the ten: `present`, `absent`, `exists_matching`, `equals`, `in_set`, `within`, `older_than`, `newer_than`, `greater_than`, `less_than`. One function each, one template each, every signature taking its subject as data.
- `guards.py` — the `on_absent` guard, applied identically ahead of a relation and an `impl` body, so the two shapes differ only in what runs after it.
- `helpers.py` — the allow-list an `impl` body may call (`days_between`, `normalize`, …). Anything not exported here fails the AST validator.
- `outputs.py` — `count`, `sum`, `list`, `copy`, `verdict`, each honouring `where: pass|fail`.
- `state.py` — `RunState`: records keyed by node_id, verdicts keyed by `(node_id, record_id)`.
- `logic.py` — `rescope(state, node_ids, payload)`. The fail-edge re-entry verb (§8.1).
- `activities.py` / `workflow_base.py` — Temporal activity wrappers + base workflow with signal plumbing. One worker serves every process; the workflow it runs is whichever generated module the spec names.

**Generated code contains no verbs** — only `ir.topo_order` walked, loops where `loop_scopes` says `many`, and `@workflow.signal` handlers from `ir.fail_handlers` with `timeout` / `max_attempts` / `on_exhausted`.

### 8.1 The fail edge — one execution, narrowed on re-entry

This is the capability that separates the system from a workflow builder, so the semantics are worth pinning exactly.

**Order of operations, inside a single workflow execution:**

```
policy verdict = fail
  └─ send discrepancy email             ← live Composio send, immediately on fail
  └─ await workflow.wait_condition(reply_received, timeout)
       ├─ signal arrives
       │    └─ logic.rescope(state, ["rec_batch"], reply)
       │         narrows state to the failed records of the rescope nodes,
       │         merges the reply payload, re-runs ir.rescope_order only
       │    └─ fall through to the output node
       └─ timeout
            └─ on_exhausted: escalate | halt | continue
```

**It is never a new workflow run.** The signal resumes the execution that was already parked, with the state it already had — that's why `rescope` can narrow to *the batches that failed* rather than reprocessing the shipment. A system that starts a second run has to rebuild context from scratch and can't distinguish "these three batches" from "this invoice." The re-entry with narrowed scope is the whole answer.

**`runtime/logic.py`** — one more noun-free verb:

```python
def rescope(state: RunState, node_ids: list[str], payload: Payload) -> RunState:
    # Narrow state to the failed records of node_ids, merged with payload.
    # Records that already passed are untouched and are not re-checked.
    ...
```

Generated code then walks `ir.rescope_order` (`["rec_batch", "rule_coa"]`) instead of the full `topo_order`, and continues to the output node. Verdicts for records outside the scope stand as they were.

**Timers: same mechanism, two values.**

| | `timeout` | `on_exhausted` |
|---|---|---|
| Demo spec | `PT30S` | `continue` |
| Production | `P5D` | `escalate` |

Only the value differs — the wait is a real durable `wait_condition` in both. `PT30S` is commented in the spec as a demo value so it doesn't read as a typo for five days. The run parks visibly on camera, the signal arrives (or doesn't), and it falls through to output.

**`on_exhausted` gains a third value: `escalate | halt | continue`.** Two weren't enough once the timeout path became real — "carry on with the verdicts we have" is a distinct and reasonable answer to a chase that went unanswered, and it's what lets the demo terminate cleanly rather than dead-ending.

**Live vs. captured — the send has two modes, and the spec doesn't choose.** Under `cli eval` and `cli heal`, outbound sends are written to `processes/<id>/captured/` and asserted against; nothing is delivered. The live send happens only in the demo run and in verification item 16.

That isn't squeamishness about email. A heal loop is up to 5 iterations over 10 fixtures, several of which fail by design — deliver those and you send dozens of real emails per run, make the loop non-deterministic, and burn a Gmail rate limit in the middle of the build. Capturing also makes the send *testable*: `captured/` holds the rendered subject and body, so `{rec_inv.invoice_number}` interpolation and `{rec_batch.batch_number where fail}` filtering are asserted rather than eyeballed in an inbox.

Mode is a run-level flag, never a spec key — the same `spec_hash` sends live on camera and captures under eval. `captured/` is regenerated output, and `heal_guard`'s "only inside `agent/`" rule already keeps the heal loop out of it.

**What's stubbed, precisely.** The inbound Gmail poller. Nothing else. A fixture injects a payload shaped like an inbound message, so `correlate_on: invoice_number` matches against real data and is covered by a test.

> **`timeout` and `max_attempts` are pickers, not typed values.** `binding` stays two-valued — they're `control` keys over a fixed enum (`PT30S | PT1H | P1D | P5D | P14D`, `1 | 2 | 3 | 5`). `render()` relabels them for her — `PT30S` → "30 seconds (demo)", `P5D` → "5 business days" — while the stored value stays ISO-8601 so codegen parses it directly. A duration outside the list is an implementer edit, not a question; a chase count past a handful means the process needs different escalation, not a bigger number. No schema change, no new `answer_kind`, no extra CI assertion.

---

> **Build order matters more than usual here.** Write `runtime/tests/` against a **synthetic three-node spec** (`a1 → p1 → o1`, fields `f1`/`f2`) and make the runtime pass *before* the receiving agent exists. An API whose first caller has no domain cannot be shaped around one. *Then* hand-write `processes/shipment_receiving_001/agent/` against that runtime, get it to 10/10, and only then build codegen aimed at reproducing it. The hand-written agent defines the target and becomes the worked example in `SKILL.md`; without it the codegen agent has nothing to aim at and you burn hours discovering runtime gaps through an LLM.

---

## 9. Codegen — `cli gen --spec <hash>`

`skills/spec-to-agent/SKILL.md` + `templates/` keyed on the same registry enums — `policy.relation.py.j2` (parameterised by the ten), `policy.impl.py.j2`, `output.count.py.j2`, one per enum value, so the template set and the type system extend together or not at all.

**The skill's input is the frozen spec and nothing else.** It never reads the project README, never sees the domain framing, and receives no examples from the process it's generating. If it needs domain context to emit correct code, the spec is insufficient — which is precisely the property being tested.

**`verify_generated.py` — an AST lint that makes the README's constraints mechanical, not policy:**

- imports resolve only to `runtime.*` and stdlib,
- defines no function matching a runtime verb name (no reimplemented `count`, no inline presence check),
- **any function it does define is byte-identical to an `impl.body` in the spec** — the one legal way for logic to appear in generated code, and a string comparison rather than a judgment call,
- contains no string literal that isn't traceable to a spec value (catches a hallucinated domain assumption),
- every node in `ir.topo_order` appears in the emitted workflow,
- every `ir.fail_handlers` entry has a corresponding `@workflow.signal`.

Fail the lint → regenerate, don't patch. "The skeleton is a runtime library; rewriting it to pass a test is not a fix" becomes a check that runs.

---

## 10. Evals + self-heal — `cli fetch | eval | heal`

All commands take `--process <id>` and operate inside `processes/<id>/`. There is no default.

- `cli fetch --process shipment_receiving_001 --live` resolves the board's channel `tool` through the runtime dispatch table, pulls real messages, and snapshots them to `processes/<id>/fixtures/`. Run live on camera; the heal loop then replays from disk so iterations are deterministic and fast. Note the fetch path is generic — a process whose channel is `http.get` snapshots the same way.
- `processes/<id>/expected/` holds the provided eval suite. **Assumption to verify on day 1:** its exact format is unknown to me — keep the label adapter thin and isolated in one file, both so a format surprise costs minutes and so a second process can bring a different label format without touching the runner.
- Outbound sends are captured to `processes/<id>/captured/`, never delivered, and asserted against — rendered subject and body included, so template interpolation is covered by the suite (§8.1).
- Report per fixture: expected vs actual **plus `extracted_state`** — the values the agent actually pulled. A count mismatch says something is wrong; a trailing space next to a clean string says what.
- Classify extraction-failure vs logic-failure *before* patching. State a root cause before producing a diff.
- Cap 5 iterations, halt if failures aren't strictly decreasing. Append every pass to `processes/<id>/heal-log.md`.

**`heal_guard.py` enforces the five constraints mechanically:** reject any diff touching outside `processes/<id>/agent/` — which now catches edits to `runtime/` *and* to another process; hash-check `expected/`; re-verify `spec_hash` each iteration; grep that every `# assumption c_NN` line survives. On unresolvable ambiguity: halt, write a comment row against the originating node, surface it on the board. (The *re-freeze → v2 rebuild* cycle is deliberately out of scope: halting and writing the comment is cheap, but regenerating from a v2 spec is a second product surface.)

Each stage writes `spec_builds`; Realtime streams `generating → testing 7/10 → healing → built 10/10` to the locked board.

## 11. Sequencing (48h)

| # | Block | h | Why here |
|---|---|---|---|
| **0a** | **Spike both external dependencies, and land `.env.example` while doing it.** Composio: authorize Gmail, pull 10 messages + attachments, open one PDF, print text. Temporal: dev server, one workflow, one activity, one signal, driven from a test. Every credential this turns up goes straight into `.env.example` (§3.1) rather than a shell history. | **2** | Both sit outside your control. Discovering an auth wall two-thirds through the build is the worst outcome available, and email ingestion was an explicit design-review objection. |
| 0b | Scaffold, migrations, `check-nouns` + pre-commit hook, park source material in `docs/source-material/`, seed the deliberately-messy receiving board | 2 | The lint exists before there's anything to lint. Retrofitting it means deleting code. |
| 1 | `packages/compiler`: elaborate, `kinds`/`ask`/`templates` registry, `optionSources`, findings, mutations, freeze; synthetic per-code tests + the askable-or-defaulted CI test | 8 | The spine. Everything downstream reads it. |
| 2 | Canvas + pins + comment panel + confirm/reject affordance + mutation apply txn | 6.5 | |
| 3 | Review worker: `render()` (options → binding → model relabel), Pass A adapter, Pass B constrained call, **policy resolution loop** (clarify → resolve to `check`/`impl` → play back in her field names → confirm), dedupe, decision log | 6.5 | The resolution loop is the new centre of gravity. |
| 4 | Freeze UI, locked board, Realtime build status | 3 | |
| **5** | **Second board — draw a different process, run review, reach freeze** | **1.5** | Moved up from last. It's the #1 design-review objection and the only thing that *demonstrates* generality. Everything it needs exists by now, and doing it here makes it a test of the front half rather than an epilogue. |
| 6 | `runtime/` **against the synthetic spec**, channel dispatch table, Temporal worker | 4 | Cheaper now that 0a proved the Temporal path. |
| 7 | Composio fetch + **hand-written reference agent to 10/10** | 2.5 | Cheaper now that 0a proved auth and attachment parsing. |
| 8 | `SKILL.md` + templates (ten relations + `impl`) + `cli gen` + `verify_generated.py` + **`impl` AST validator** | 6 | Ten relation templates are near-identical; the validator is the real work. |
| 9 | Eval runner, classifier, heal loop, `heal_guard.py`, heal-log | 4 | |
| **9b** | **Fail edge** — live Composio outbound send, `wait_condition`, signal handler, `logic.rescope`, timeout path, fixture-injected signal + correlation test | **3** | Promoted from cut to headline. It's the answer to "why isn't this a workflow builder," and the demo now has a visible parked run that resumes. |
| **10** | **Front-end polish** — typography, spacing, card design, comment panel | **1** | Design-review objection #2: "presentable for a client." React Flow's defaults look like a developer tool. The folding rules are the substance, but they land differently with considered visual design. |
| 11 | README rewrite, Loom | 1.5 | |

**48h exactly, twice over.** The fail edge cost 3h; the policy pivot cost another 2.5h (block 3 +1.5, block 8 +1) and was funded by trimming canvas, eval and polish by 0.5h each, plus deleting the `comparison`-kind stretch outright — `within`, `greater_than` and `less_than` now ship in the ten, so that extension is baseline rather than a demo. **This is the last thing that fits**; the next addition comes out of a named block, not out of slack, because there is none.

Where the fail edge's 3h came from:

- **Third example board: cut (−1h).** Two domains prove generality; the third was already first on the chopping block.
- **`docs/extending.md`: cut (−0.5h).** The four-files extension path is documented in §1 and §4's tier table; a separate file repeats it. Fold two sentences into the README instead.
- **Polish 2 → 1.5h (−0.5h)**, **heal loop 5 → 4.5h (−0.5h)**, **README/Loom 3 → 1.5h (−0.5h)** — the last because this plan now carries enough of the argument that the rewrite is editing, not composing.
- Earlier: the 2h spike partly funds itself (blocks 6 and 7 drop from 5+3 to 4+2.5), and the second board moved to block 5 cost-neutrally.

**That trade is worth taking.** A third example board is a stronger *generality* proof than a second; but the fail edge is the only thing in the build that no low-code tool can do, and "the run parked, an email arrived, I replied, and it resumed re-checking only the failed batches" is the single most convincing thirty seconds of the Loom.

If you still slip: Pass B's richness goes next — Pass A alone still demonstrates the thesis. **Do not cut 0a, block 0b's lint, block 5, block 6's synthetic-first ordering, or 9b's live send.** A stubbed outbound send guts the point of 9b.


### Mapping to the grading criteria

- **Primitive design** — 4 kinds, each one sentence; the node-vs-field mechanical test; example boards from unrelated industries freezing under one registry; and the four tiers, which give a principled answer to "what if my check isn't in your list" instead of a shrug.
- **Comment loop not decorative** — every comment carries a mutation, `mutation` is `not null`, answering performs a structural edit in one transaction, and the comment that caused it stays attached to the node forever. The board visibly changes.
- **Spec correctness** — the frozen spec carries `compiled` IR, so sufficiency isn't a judgment call: codegen consumes exactly what the checker produced, gets no other context (§9), and `verify_generated.py` proves the generated code covers every node and handler.
- **Repo structure** — verbs in `runtime/`, type system in `packages/compiler/`, every domain confined to `processes/<id>/`, and a lint that fails the build if that stops being true.
- **Communication** — the context firewall named up front (§2); In Scope restated as capabilities rather than a feature list for one process; the Loom leads with the one-function/two-outputs idea and closes on the second board. The README's Open Questions get walked to where each conflict actually landed: the undefined-mismatch question is `missing_conditional_key` on `verdict_on` and the compiler asks it verbatim; the two-outputs question is a Pass B proposal that Pass A then completes; and the four-fields-or-five question the system **doesn't** resolve — it forces the decision to be explicit, attributable, and protected as an `# assumption c_NN`. Showing that the third isn't compiler-decidable is stronger than claiming all three are.
- **Ambiguity handling** — graded explicitly, and answered in three places. §2 draws the line between what the type system decides and what a human decides; `binding` says where ambiguity is *allowed* to live (an extraction prompt) versus where it's structurally impossible (control flow); and the policy's two shapes say what happens when no relation fits — the agent writes the function, three gates constrain it, and she signs it off before it can freeze.
- **Judgment** — the fail edge built at full fidelity with only the inbound poller stubbed, funded by explicitly cutting the third example board and `docs/extending.md`; the heal → re-freeze → v2 rebuild cycle still cut. Every trade named with its reason, not omitted silently.

---

## 12. Verification

**The type system**
1. `pnpm --filter compiler test` — one synthetic fixture per finding code, asserting exact code + anchor + mutation.
2. `node tools/check-nouns.mjs` — zero domain nouns outside `processes/` and `examples/`.
2b. Firewall test — the assembled Pass B prompt contains no string drawn from `docs/source-material/`, and the codegen invocation's context is the frozen spec alone.
2c. Secrets — `.env.example` has every key `env.ts`/`env.py` require; a frozen spec contains no credential; unset `COMPOSIO_API_KEY` and confirm the CLI exits naming it, rather than failing mid-run.
3. All `examples/` boards elaborate to zero blocking findings and produce stable hashes across two runs.
4. Registry coherence — the askable-or-defaulted test passes; add a template reading an undeclared key and confirm CI goes red.
5. Option sources — `pair_on` on parents sharing no field yields a `missing_field` precondition finding, not an empty dropdown.

**Policies**
5b. A described policy resolves to a relation — assert `check.relation`, `reads` in her field paths, and a `derived` comment whose `proposal` plays it back in her labels, never in relation names.
5c. A description no relation fits resolves to an `impl` — assert `signature == reads`, and that the AST validator rejects three planted bodies: one importing `os`, one reading an undeclared field, one calling an unlisted helper.
5d. Freeze with `confirmed_by` pointing at an unconfirmed comment → blocked by `open_comment`. Confirm it → freeze succeeds.
5e. Same spec generated twice → byte-identical `impl` in both outputs.
5f. `on_absent` guards both shapes identically — a fixture with an empty read field yields the same verdict under a relation and under an `impl`.

**The loop**
6. Seed the messy board → Review → assert round 1 contains `demote_to_field` on the five attribute nodes, ranked first.
7. Answer it → assert one transaction collapsed five nodes into five fields, rewired the policy's `reads`, and left the comment `resolved` with its mutation and answer intact.
8. Round 2 → assert at least one finding that could not exist before the collapse (the `verdict_on` / cardinality question).
9. Submit → assert failure names node IDs while a hole remains; then assert pass writes an immutable row and locks the board.
10. Run the *same worker* against the loan-file board with two keys removed → same finding codes, different nouns, no code changes.

**The build**
11. `cli fetch --process shipment_receiving_001 --live` → messages land in `processes/<id>/fixtures/`.
12. `cli gen --spec <hash>` → `processes/<id>/agent/` emitted; `verify_generated.py` passes, including the no-untraceable-string-literal check.
13. `cli eval` → report includes `extracted_state`; inject a trailing-whitespace bug and confirm the classifier says *extraction*, not *logic*.
14. `cli heal` → `heal_guard.py` rejects a patch touching `runtime/`, one touching `expected/`, and one touching a different process's directory.
15. Temporal worker runs the generated workflow end-to-end; the locked board streams `generating → testing → healing → built` with no polling.

**The fail edge**
16. **Demo run only** — a failing `exists_matching` verdict sends a real email to `danieljhsiao@gmail.com` and the workflow parks in `wait_condition`; confirm in the Temporal UI that the execution is running, not completed. Then confirm `cli eval` on the same spec delivers nothing and writes to `captured/` instead.
17. Inject the fixture signal → assert `correlate_on: invoice_number` matched, `logic.rescope` narrowed to the failed batches only, and records that passed were **not** re-checked.
18. Assert the resumed run is the **same workflow execution id** as the parked one — a new run id here means the capability isn't what it claims.
19. Let a run hit `PT30S` with no signal → `on_exhausted: continue` falls through to the output node with the standing verdicts.
20. Swap the spec to `on_exhausted: escalate` and confirm the timeout path branches differently — proves the enum is read, not hardcoded.

**Generality**
21. Draw the second process live on the canvas, run review, reach freeze. Nothing in `packages/compiler/`, `runtime/`, or `apps/web/` is touched to make it work — that non-diff is the demo.
