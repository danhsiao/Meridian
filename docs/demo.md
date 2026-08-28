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

Four, and only the first is needed for the whole demo.

```
Shell 1   the demo itself — every cli command below
Shell 2   temporal server start-dev          (only for `cli run`)
Shell 3   python -m runtime.worker           (only for `cli run`)
Shell 4   npm run worker                     (only for the canvas / review half)
```

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

# 3. snapshot the inbox  — LIVE, reaches Gmail through Composio
#    --query overrides the board's under-fetching match for this snapshot only
.venv/bin/python -m cli fetch --process final_test --limit 40 --live \
    --query 'has:attachment'

# 4. generate the agent — this invokes the skill, a model writes agent.py
.venv/bin/python -m cli gen --process final_test

# 5. diff it against the hand-written reference
diff processes/final_test/reference/agent.py processes/final_test/agent/agent.py

# 6. score it
.venv/bin/python -m cli eval --process final_test
```

Step 3 takes about a minute. Step 4 takes one to three minutes — the skill is
reading the spec and writing a file. Step 6 replays from disk and is fast
*because extraction is cached*; the first ever eval took ~40 minutes and every
one since has been seconds.

### Generality, in one command

```bash
.venv/bin/python -m cli gen --process different_use_case
diff processes/final_test/agent/agent.py processes/different_use_case/agent/agent.py
```

Two industries, one skill, one template set.

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
.venv/bin/python -m cli run --process final_test
```

Then open **http://localhost:8233** and click into the completed execution. The
thing to point at is the **Input** pane: `"module": "processes.final_test.agent"`
— that is the evidence the generated agent ran, not the hand-written reference.

Takes ~26s over 15 fixtures. Result lands in
`processes/final_test/reports/run.json`.

If the worker is not running, `cli run` will sit waiting rather than failing —
the workflow is queued and nothing picks it up. That is Temporal behaving
correctly, but on camera it looks like a hang, so start the worker first.

---

## Part C — the heal loop (human in the loop)

```bash
.venv/bin/python -m cli eval --process final_test      # read the report
# ... you read processes/final_test/reports/eval.json, then in Claude Code:
/heal-agent
.venv/bin/python -m cli eval --process final_test      # re-run — this is the checkpoint
```

The skill classifies, states a root cause, patches inside
`processes/<id>/agent/`, and stops. It never re-runs the suite; you do.

**Know this before recording:** `cli gen` overwrites `agent/`, so a regeneration
discards every heal pass. The agent as it stands is un-healed and scores
**3/12**. If you want to show `4/12`, run `/heal-agent` *after* the last
`cli gen` and before the eval. See
[blocks-6-9.md](blocks-6-9.md#healing-and-regeneration-are-in-tension-and-nothing-resolves-it-yet).

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
