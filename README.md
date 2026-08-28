# Autonomous Workflow Engine (Meridian take-home)

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
| `runtime/` | The hand-written runtime library (code skeletong) generated agents link against: extraction, identity merging, relations, policy verbs, output verbs, channels (Composio / capture / replay), and the Temporal worker. |
| `skills/` | `spec-to-agent` (spec + 9 Jinja templates → `agent.py`) and `heal-agent` (classify eval failures, patch, stop). |
| `processes/` | One directory per compiled process: its pulled `spec.json`, generated `agent/`, hand-written `reference/`, labels in `expected/`, and gitignored `fixtures/` and `reports/`. |
| `tests/` | Integration tests over the real example boards; the compiler's own synthetic-id tests live beside it in `packages/compiler/src/__tests__/`. |
| `tools/` | `doctor.mjs` (one-command checkout verification), `seed-sql.mjs`, `write-env.sh`, `check-nouns.mjs`. |
| `docs/` | [local-dev.md](docs/local-dev.md) (setup in depth), [demo.md](docs/demo.md) (recording runbook)

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
./cli.sh specs                                 # frozen specs on the bus
./cli.sh pull  --spec cce7715b                 # bus -> processes/<id>/spec.json
./cli.sh fetch --process final_test --live     # snapshot Gmail -> fixtures/  (~1 min)
./cli.sh gen   --process final_test            # the skill writes processes/<id>/agent/
./cli.sh eval  --process final_test            # score against expected/
```

`fixtures/` is gitignored — it is a verbatim copy of a real inbox — so a fresh
clone must run `fetch` before `eval` or `run` has anything to read.

`run` is the only command that goes through Temporal, and the only one needing a
worker. In three shells:

```bash
temporal server start-dev --ui-port 8233       # shell 1
.venv/bin/python -u -m runtime.worker          # shell 2
./cli.sh run --process final_test              # shell 3
```

The completed execution at http://localhost:8233 records
`"module": "processes.final_test.agent"` — evidence the *generated* agent ran,
not the hand-written reference. Results land in `processes/<id>/reports/`.

To heal a failing eval, read `reports/eval.json`, run `/heal-agent` in Claude
Code, then re-run `eval` yourself. Note that `cli gen` overwrites `agent/`
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
npm run check    # lint:nouns + typecheck + 171 tests, no database needed
```

---

## How it works

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
