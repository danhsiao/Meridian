# Demo runbook

Ordered for a recording. Each section says which shell it belongs in and what
has to already be running.

## Two execution paths, and only one needs a worker

This trips people up, so it is worth being explicit:

| Command | Goes through Temporal? | Needs the worker running? |
|---|---|---|
| `cli fetch` | no | no |
| `cli gen` | no | no |
| `cli eval` | **no** — imports the agent module and calls it in-process | **no** |
| `cli run` | **yes** | **yes** |

`cli eval` deliberately does not use Temporal. The eval loop has to be
deterministic and fast, and putting a workflow engine between the runner and the
agent would add a moving part that changes nothing about the score. `cli run` is
the one that demonstrates durable execution.

---

## Shells

Shell 1 (Canvas & DB): Run supabase start, npm run env:local, npm run db:seed:examples, and npm run dev (UI is at localhost:3000).
Shell 2 (Review Agent): Run npm run worker.
Shell 3 (Codegen & Eval CLI): Run the sequence to pull the spec 
./cli.sh specs 
cli pull  --spec <hash>
cli fetch --process <id> --live --query '<gmail query>'   # once, seeds queries.json
cli gen   --process <id>
cli run   --process <id>                 fina                  # ✓ live, new emails included
# eval/heal only after you write expected/results.json + expected/adapter.py

If you want to run the cli commands against the whiteboard I made:

```bash
./cli.sh specs
./cli.sh pull –spec cce7715b
./cli.sh gen –process demoboard
./cli.sh eval –process demoboard
```

Shell 4 (Temporal Server): Run temporal server start-dev --ui-port 8233.
Shell 5 (Temporal Worker): Run .venv/bin/python -u -m runtime.worker. Once it's listening, use Shell 3 to run the agent (./cli.sh run --process demoboard) and watch it execute at localhost:8233. When you're done, tear it down with supabase stop and kill the Temporal processes.

---

## Before you record

```bash
cd "/Users/danielhsiao/meridian take home"

# Is anything already up? (all four are idempotent to check)
nc -z localhost 7233 && echo "temporal: up"
nc -z localhost 8233 && echo "temporal UI: up"
nc -z localhost 54322 && echo "supabase: up"
pgrep -f runtime.worker >/dev/null && echo "worker: up"
```

`.env.local` must exist and carry the Composio, Anthropic and Temporal keys.
Every command prints its credentials masked on the first line, so if something
401s you can see immediately which key was in play.

---

## Part A — the back half (no Temporal needed)

**Shell 1.**

```bash
# 1. what has been frozen
.venv/bin/python -m cli specs

# 2. bring a frozen spec down from the bus onto disk
.venv/bin/python -m cli pull --spec cce7715b

# 3. seed the provider query — LIVE, reaches Gmail through Composio
#    The board's match reads 'Emails that has the subject line "Pre-Alert
#    Documents" belong in inbox'. The real subject is "Pre Alerts Documents",
#    plural — so the board's own filter matches nothing. This is that filter
#    transcribed into Gmail syntax, remembered in queries.json and reused by
#    every later fetch, including the agent's own.
.venv/bin/python -m cli fetch --process demoboard --limit 40 --live \
    --query 'subject:"Pre-Alerts Documents"'

# 4. generate the agent — this invokes the skill, a model writes agent.py
.venv/bin/python -m cli gen --process demoboard

# 5. read the channel node: the Composio integration is IN the agent
grep -A 3 'channel in' processes/demoboard/agent/agent.py

# 6. score it
.venv/bin/python -m cli eval --process demoboard
```

Step 3 takes about a minute. Step 4 takes one to three minutes — the skill is
reading the spec and writing a file.

Step 5 is the thing to point at. The generated agent emits

```python
items += channels.inbound(spec, "cha_1", given=payloads)
```

at its channel node — it resolves `composio.gmail` from its own spec and
fetches for itself. Nothing in `cli/` resolves a transport, and the generated
code never names a provider: a board carrying `http.get` emits the same line.

Step 6 re-fetches the inbox first, because `cli eval` and `cli run` both default
to the live channel now — an explicit `cli fetch` is a way to snapshot without
running, not a prerequisite. Extraction is still cached per payload, so a mail
that was in the last snapshot costs nothing to score again and only genuinely
new mail pays for a model call; the first ever eval took ~40 minutes and one
over an unchanged inbox is seconds. Pass `--replay` to skip the fetch and score
the last snapshot exactly.

A newly arrived mail has no labelled case in `expected/results.json`, so it
cannot move the score — it appears in `unmatched_fixtures` in the report, and
that list is where you look to confirm it was picked up.

### Generality, in one command

```bash
.venv/bin/python -m cli gen --process different_use_case
diff processes/demoboard/agent/agent.py processes/different_use_case/agent/agent.py
```

Two industries, one skill, one template set. The diff is entirely node ids and
templates — including `different_use_case`'s outbound channel, which emits
`channels.outbound(...)` where `demoboard` has no send at all.

---

## Part B — durable execution through Temporal

**Shell 2** (leave it running):

```bash
temporal server start-dev --ui-port 8233
```

**Shell 3** (leave it running):

```bash
cd "/Users/danielhsiao/meridian take home"
.venv/bin/python -u -m runtime.worker
# prints: worker listening on workflow-engine
```

**Shell 1:**

```bash
.venv/bin/python -m cli run --process demoboard
```

Then open **http://localhost:8233** and click into the completed execution. Two
things to point at in the **Input** pane:

- `"module": "processes.demoboard.agent"` — the generated agent is what ran.
- `"payloads": null` — the CLI handed it nothing. The agent's channel node
  reached Composio from inside the activity and fetched the inbox itself.

Result lands in `processes/demoboard/reports/run.json`.

If the worker is not running, `cli run` will sit waiting rather than failing —
the workflow is queued and nothing picks it up. That is Temporal behaving
correctly, but on camera it looks like a hang, so start the worker first.

---

## Part C — the heal loop (human in the loop)

eval/heal only after you write expected/results.json + expected/adapter.py

```bash
.venv/bin/python -m cli eval --process demoboard --replay   # read the report
# ... you read processes/demoboard/reports/eval.json, then in Claude Code:
/heal-agent
.venv/bin/python -m cli eval --process demoboard --replay   # re-run — the checkpoint
```

`--replay` on both, and it matters: it pins the two runs to the same payloads,
so a metric that moved moved because of the patch. Drop it and the inbox is
re-fetched each time, which is what you want for a demo run and exactly what you
do not want either side of a fix.

The skill classifies, states a root cause, patches inside
`processes/<id>/agent/`, and stops. It never re-runs the suite; you do.

**Know this before recording:** `cli gen` overwrites `agent/`, so a regeneration
discards every heal pass. Run `/heal-agent` *after* the last `cli gen` and
before the eval, never the other way round. Nothing guards this today — the
skill patches `processes/<id>/agent/` and `cli gen` rewrites that directory.

---

## Part D — the canvas and review agent (blocks 0b–5)

Only if you are demoing the front half too.

**Shell 4:**

```bash
supabase start          # if not already up
npm run worker          # the review agent's LISTEN loop
npm run dev             # the canvas at localhost:3000
```

---

## Shutting down

```bash
pkill -f runtime.worker
pkill -f "temporal server"
supabase stop
```

---

## If something goes wrong on camera

| Symptom | Cause | Fix |
|---|---|---|
| `401 Invalid API key` | a stale key exported in your shell | `.env.local` already wins; check the masked prefix on line 1 of the output |
| `cli run` hangs | worker not running | start Shell 3 |
| `connection refused :7233` | Temporal server not running | start Shell 2 |
| `no fixtures at …` | never fetched | run step 3 |
| `EXTRACT_OFFLINE …not cached` | `--offline` on an unseen prompt | drop `--offline` |
| eval much slower than expected | extraction cache was cleared | it is under `.cache/extract/`, gitignored — expect the first run to be slow again |
