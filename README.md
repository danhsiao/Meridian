# Autonomous Workflow Engine (Meridian take-home)
Deliverable Doc: [Meridian Take Home.pdf](https://github.com/user-attachments/files/31578589/Meridian.Take.Home.pdf)
Daniel Hsiao · 48 hours

A non-technical process owner draws their process on a whiteboard. An AI review
agent interviews their about it until it is complete enough to compile. Freezing
the board emits an immutable, hashed spec, and a codegen skill turns that spec
into a Python agent that runs on Temporal against real emails.

**The framing is an IDE for business workflows.** The whiteboard is the source
code, the review agent is the language server, comments are inline diagnostics
that carry their own quick fix, freeze is the type check, the frozen spec is the
IR, and the eval fixtures are the test suite. Compilation runs one direction: a
failing test may patch the generated agent, never the spec.

The demo process is inbound pharmaceutical import receiving, but the engine
ships no domain nouns — `npm run lint:nouns` fails the build if one leaks in.
Every industry-specific word lives in a user-typed `label` or `source_hint`.

---

## Repo structure

| Path | What it is |
|---|---|
| `apps/web/` | The canvas. Next.js 15 + React Flow. Draws the board, folds obvious structure into cards, renders comments as pins, and calls freeze. |
| `packages/compiler/` | The engine, as pure functions: the registry (`registry.json`), Pass A findings, mutations, the five freeze predicates, and the renderer's fold rules. No I/O, no model, no domain nouns. |
| `packages/review-worker/` | The review agent's process. Wakes on Postgres `LISTEN review_runs`, runs Pass A (code) then Pass B (model), writes comments back as rows. |
| `supabase/` | The bus. Migrations for the 8 tables, `config.toml` for the local stack, and a generated `seed.sql`. The canvas, worker and CLI coordinate only through these rows — none of them calls another. |
| `examples/` | Three boards as JSON (frozen JSON specs), used to prove for all use cases, not just take home assignment. 
| `cli/` | The Python CLI: `specs`, `pull`, `fetch`, `gen`, `eval`, `run`. The back half's only entry point. |
| `runtime/` | The hand-written runtime library (code skeletong) generated agents link against: extraction, identity merging, relations, policy verbs, output verbs, channels (the Composio adapter, the verbs generated agents call, capture and replay), and the Temporal worker. |
| `skills/` | `spec-to-agent` (spec + 12 Jinja templates → `agent.py`) and `heal-agent` (classify eval failures, patch, stop). |
| `processes/` | One directory per compiled process: its pulled `spec.json`, generated `agent/`, labels in `expected/`, an optional `queries.json`, and gitignored `fixtures/` and `reports/`. |
| `tests/` | Integration tests over the real example boards; the compiler's own synthetic-id tests live beside it in `packages/compiler/src/__tests__/`. |
| `tools/` | `doctor.mjs` (one-command checkout verification), `seed-sql.mjs`, `write-env.sh`, `check-nouns.mjs`. |
| `docs/` | [demo.md](docs/demo.md) — the runbook: what to run, in which shell, in what order. |

---

## Running it

### Prerequisites

Docker Desktop **running**, Node 20+, the Supabase CLI
(`brew install supabase/tap/supabase`), and Python 3.11+ for the back half.

### Front half — canvas + review agent

```bash
npm install
supabase start            # first run pulls ~1GB of images
npm run env:local         # writes .env.local (mode 600) from the running stack
npm run db:seed:examples  # regenerates seed.sql with the 3 sample boards, resets the db
```

Then two processes, in two terminals:

```bash
npm run dev               # canvas    http://localhost:3000
npm run worker            # the review agent, listening on review_runs
```

| | |
|---|---|
| Canvas | http://localhost:3000 |
| Supabase Studio | http://127.0.0.1:54323 (schema `public`) |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |

### Back half — codegen, eval, Temporal

```bash
python3 -m venv .venv
.venv/bin/pip install anthropic composio pypdf python-dotenv temporalio pytest
```

Then, with a frozen spec on the bus (`./cli.sh` is a shorthand for
`.venv/bin/python -m cli`):

```bash
./cli.sh specs                                # frozen specs on the bus
./cli.sh pull  --spec cce7715b                # bus -> processes/<id>/spec.json
./cli.sh fetch --process demoboard --live \
    --query 'subject:"Pre-Alerts Documents"'  # once — seeds queries.json
./cli.sh gen   --process demoboard            # the skill writes processes/<id>/agent/
./cli.sh eval  --process demoboard            # fetch Gmail, then score against expected/
```

**The `fetch` line is needed once on a fresh clone, and the reason is a finding
against the board rather than a setup chore.** `match` is a `prompt`-bound key —
prose the operator typed — and this board's reads *"Emails that has the subject
line "Pre-Alert Documents" belong in inbox"*. The real subject line is
`Pre Alerts Documents`, plural, so the board's own filter matches nothing. The
`--query` above is that filter transcribed faithfully into Gmail syntax; it
returns the same 16 messages the labels were written against. Nothing validates
a channel filter against the transport it targets, so the board froze clean and
would fetch zero — that gap is listed under *What I'd do differently*.

**The Composio integration lives in the generated agent, not in the CLI.** Every
`agent.py` emits its channel node as a call:

```python
# ── cha_1 (channel in, tool=composio.gmail) ──
items += channels.inbound(spec, "cha_1", given=payloads)
```

`cli run` passes no payloads, so the agent resolves `composio.gmail` from its own
spec and fetches for itself; the inbox as it is now, including mail that arrived
five minutes ago. Nothing in `cli/` resolves a transport and nothing in a
generated agent names a provider — `channels.inbound` reads the `tool` string
from the spec and dispatches, so a board carrying `http.get` emits the same line.

`given` is the one override, and it exists for `cli eval`: the suite scores one
labelled case at a time and has to hand the agent that case's payloads. It is
also what `--replay` rides on, which is what makes a heal loop's two runs
comparable — two evals over a moving inbox cannot tell a patch that worked from
an inbox that changed.

Outbound works the same way (`channels.outbound`) and captures to `captured/`
unless `run --live` says otherwise. Sending is not idempotent, so it fails safe
in the direction that is recoverable; reading is, so it defaults live.

`./cli.sh fetch --process <id> --live` snapshots without running and takes a
`--query` override — needed because a board's `match` is prose an operator
wrote, not a provider query language. A working override is remembered in
`processes/<id>/queries.json` beside the spec (never in it, so `spec_hash` is
untouched) and honoured by the agent's own fetch. `fixtures/` is gitignored — it
is a verbatim copy of a real inbox — so a fresh clone has nothing to `--replay`
until one live run has filled it.

`run` is the only command that goes through Temporal, and the only one needing a
worker. In three shells:

```bash
temporal server start-dev --ui-port 8233       # shell 1
.venv/bin/python -u -m runtime.worker          # shell 2
./cli.sh run --process demoboard              # shell 3
```

The completed execution at http://localhost:8233 records
`"module": "processes.demoboard.agent"` and `"payloads": null` — evidence that
the *generated* agent ran and that it fetched the inbox itself. Results land in
`processes/<id>/reports/`.

**`eval` and `/heal-agent` need labels, and labels are hand-written.** A process
scores only once `processes/<id>/expected/results.json` (the labelled cases) and
`processes/<id>/expected/adapter.py` (the metric → node-id table) exist. Neither
can be generated: the adapter encodes which artifact node holds which business
metric, which is a human judgement about that board. `demoboard` ships both;
`whiteboard` and `different_use_case` ship neither, so on those two `gen` and
`run` work and `eval` does not.

To heal a failing eval, read `reports/eval.json`, run `/heal-agent` in Claude
Code, then re-run `eval` yourself — the skill classifies, patches, and stops
without re-running the suite, so the checkpoint stays with you. Pass `--replay`
on both evals so the two runs read the same payloads; otherwise the inbox moves
underneath the patch and a metric that changed tells you nothing. Note that
`cli gen` overwrites `agent/`, so a regeneration discards every heal pass: run
`/heal-agent` *after* the last `gen`, never before. Nothing guards this today.

### Keys

Only the back half needs any. Supabase's four local values are written by
`npm run env:local` and are the CLI's published dev keys. `ANTHROPIC_API_KEY`
unlocks Pass B and codegen; `COMPOSIO_*` unlocks fetching real mail. Everything
else — the whole compiler, Pass A (~80% of comments), freeze, and every
mutation — runs on a fresh clone with no keys at all. `.env.example` documents
every key and where it comes from.

### Verifying the checkout

```bash
npm run doctor   # env, docker, schema, seed, LISTEN/NOTIFY, tests, noun lint
npm run check    # lint:nouns + typecheck + 197 tests, no database needed
```

---

## How it works
**System Architecture** 
https://lucid.app/lucidchart/0cd54a9b-917f-4eec-b28c-87dbfd840d57/edit?viewport_loc=-431%2C48%2C3178%2C1854%2C0_0&invitationId=inv_705b1a77-2e4d-49c4-ab04-813c4217442c

**Four primitives.** Channel (a connection to the outside world), Artifact (a
typed thing with fields), Policy (a check returning pass/fail), Output (what
gets computed). Unlimited nouns, enumerated verbs: four node kinds, ten policy
relations, five output functions, three edge relations — each keyed to a codegen
template. (Four of the ten relations are implemented; the rest are declared in
the registry and stated as unbuilt.)

**The database is the bus.** The browser never calls the review agent and the
CLI never calls the browser. Everything writes rows and Realtime pushes them,
which is how a five-minute build streams progress with no polling.

**The review loop.** Pass A is plain code — registry checks, graph checks, and
structural correction. Pass B is the model, and only for what requires reading English.
The model picks a finding code from a closed set and writes the wording; it
never designs the mutation. Every comment carries its mutation at creation, so
answering one is a structural edit applied in a single transaction.

**Freeze is a type check.** Five predicates run on Submit; failure names the
offending node IDs. Then `x, y` are stripped, keys sorted, and the payload
hashed — a compiler ignoring whitespace.

---

### The Data

| Table | Holds | Notes |
|---|---|---|
| `users` | `id`, `org_id`, `email` | |
| `process_maps` | a board — `title`, `status` | `status` is `draft` or `frozen`, checked |
| `nodes` | `(map_id, id)`, `primitive`, `label`, `config` jsonb, `x`, `y` | composite PK: node ids are board-local (`rec_inv`), so a global key collides the moment a second board reuses one. `label` **is** read — it reaches the extraction prompt. `x, y` are stripped before hashing |
| `edges` | `(map_id, id)`, `from_node`, `to_node`, `config` | FKs are composite into `nodes`; `unique (map_id, from_node, to_node)` |
| `review_runs` | `id`, `map_id`, `round`, `status` | an `after insert` trigger `pg_notify`s `review_runs`; the worker wakes on `LISTEN`, never polls |
| `comments` | the diagnostic — see below | |
| `frozen_specs` | `map_id`, `version`, `registry_version`, `spec` jsonb, `spec_hash` | `unique (map_id, version)`; the payload is immutable |
| `spec_builds` | `spec_id`, `status`, `iteration`, `tests_passed/total` | separate from `frozen_specs` on purpose — the frozen payload is immutable, so mutable build status lives elsewhere. Many builds per spec (re-runs, heal iterations) |

`comments` carries the most structure, because a comment is a diagnostic that
also knows its own quick fix:

| Column | Why it exists |
|---|---|
| `node_id` / `edge_id` | exactly one, never zero — `constraint one_anchor` |
| `code` | the Finding code, from a closed set |
| `severity` × `rank` | two axes, not one. `severity` answers *does this block freeze*; `rank` answers *where does it sit in the queue*. A structural correction is advisory but ranks above ordinary blocking findings, so one column cannot carry both |
| `pass` | `A` (code) or `B` (model) |
| `binding` | `control` \| `prompt` \| `derived` |
| `answer_kind` | derived from `binding`, never chosen — a check constraint enforces the pairing |
| `mutation` jsonb | **not null**. A comment without one is a note. Every comment carries its edit at creation, so answering it is one transaction |
| `proposal` | a `derived` key's resolution, shown before she can confirm it (`constraint derived_has_proposal`) |
| `preview` | what accepting will *do*, in her words — generated from the mutation, not written by a model, so it cannot disagree with what happens |
| `supersedes` | a later decision invalidating an earlier one |

### The frozen spec

What `freeze` emits and `cli pull` writes to `processes/<id>/spec.json`. Keys
sorted, `x, y` stripped, then hashed — a compiler ignoring whitespace.

```jsonc
{
  "spec_version":     "1.0",
  "registry_version": "1.0",        // additive registry bumps stay compilable
  "process_id":       "demoboard",
  "spec_hash":        "sha256:4bf2e287…",
  "nodes":    [ /* … */ ],
  "edges":    [ /* … */ ],
  "compiled": { /* … */ },
  "provenance": { "comments": ["c_23", "c_25", …], "assumptions": [] }
}
```

A node is its `primitive`, its `label` (user-typed, and read by the extraction
prompt), and a `config` whose keys the registry governs:

```jsonc
{
  "id": "art_2",
  "primitive": "artifact",          // channel | artifact | policy | output
  "label": "CoAs",
  "config": {
    "describes":    "PDFs from the PreAlert Email",
    "fields":       ["Batch No"],
    "identity_key": "Batch No",
    "source_hint":  "PDFs name CoA or has CoA in them."
  }
}
```

An edge is `{ "id", "from", "to", "config" }` — note `from`/`to` in the spec,
against `from_node`/`to_node` on the bus.

`compiled` is the part codegen actually walks. It is derived at freeze, never
hand-written, and it is what makes the generated agent a straight-line
transcription rather than an interpretation:

| Key | What it carries |
|---|---|
| `topo_order` | the node order the agent emits its steps in |
| `edge_roles` | each edge id → `contain` \| `read` \| `join` \| `derive` \| `outcome` |
| `identity_merges` | node id → the field that says two records are the same one |
| `joins` | `{edge, left, right, on}` |
| `loop_scopes` | node id → the containment edges it nests under |
| `verdict_targets` | policy id → the artifact its pass/fail lands on |
| `propagations` | `{edge, from, to}` — a verdict travelling up a containment edge |
| `fail_handlers` | per-edge failure routing |

`verdict_targets` and `propagations` are the two that decide what a metric even
means. On `demoboard` they read `{pol_1: art_5, pol_2: art_2}` and
`{edge: e_7, from: art_5, to: art_3}` — nothing judges an invoice directly, but
a goods verdict travels up `e_7`, so an invoice fails exactly when one of its
goods does.

### The registry

`packages/compiler/registry.json`, `registry_version` `1.0`.

| Key | What it fixes |
|---|---|
| `kinds` | `channel`, `artifact`, `policy`, `output`, `edge` |
| `ask` | 28 config keys the review agent may ask about, as `<kind>.<key>` (`artifact.fields`, `policy.verdict_on`, …) |
| `askable_if` | 15 keys whose askability is conditional on another answer |
| `templates` | 12 codegen templates, each keyed to a verb (`artifact.extract`, `policy.relation`, `edge.join`, …) |
| `reads_compiler` | 7 keys the compiler consumes rather than the prompt |
| `list_valued_keys` | `fields`, `reads`, `required`, `rescope` |
| `required_if_codes` | findings that make a key mandatory |

Four of the ten policy relations are implemented; the rest are declared here and
stated as unbuilt, so a board can name one and freeze will say it is not built
rather than silently generating nothing.

---

## Live demo (in order)
1. Whiteboarding Pt. 1: https://www.loom.com/share/220ed731ecba4a1c9de9eb7b56a6e6d4
2. Whiteboarding Pt. 2: https://www.loom.com/share/105cbe39a50c4ffdb21e6786a8a00163
3. CodeGen Agent/Heal Agent Pt.1: https://www.loom.com/share/083fe048b3114642bf9846c8fcdb265c
4. CodeGen Agent/Heal Agent Pt.2: https://www.loom.com/share/90a2527230dc49bab4ff2a5b8c9368af
5. CodeGen Agent/Heal Agent Pt.3: https://www.loom.com/share/b824abab26e942879c5576212c9875d8
