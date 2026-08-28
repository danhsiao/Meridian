# Running this locally

Clone to first board on screen: about ten minutes, most of it Docker pulling images once.

## What you need

| | | |
|---|---|---|
| **Docker Desktop** | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) | Must be **running**, not just installed |
| **Node 20+** | `node --version` | |
| **Supabase CLI** | `brew install supabase/tap/supabase` | [other platforms](https://supabase.com/docs/guides/local-development/cli/getting-started) |

### Starting Docker

Docker is a desktop application, not a command. Open **Docker Desktop** from
Applications or Spotlight and wait for the whale icon in the menu bar to stop
animating. On macOS you can also run:

```bash
open -a Docker
```

Confirm it's ready:

```bash
docker info      # prints server version when the daemon is up
```

> **There is no `docker-compose.yml` in this repo, and you never run
> `docker compose`.** The Supabase CLI owns the containers — it starts Postgres,
> PostgREST, Realtime and Studio for you, configured by `supabase/config.toml`,
> which *is* committed. Docker only needs to be running underneath it.

## Setup

```bash
npm install
supabase start        # first run pulls ~1GB of images; later runs take seconds
npm run env:local     # writes .env.local from the running stack
npm run db:seed       # regenerates seed.sql from examples/, then resets the db
```

`supabase start` prints your local URLs. `npm run env:local` copies the ones the
app needs into `.env.local` (gitignored, mode 600) so no credential passes
through your terminal or clipboard.

### Do you need any API keys?

**For most of it, no.** Nothing secret is committed and nothing needs to be.

The four Supabase values are the CLI's standard local development keys —
identical on every machine that runs `supabase start`, published in Supabase's
own documentation, and valid only against a container bound to `127.0.0.1`.
`npm run env:local` writes them for you. There is nothing to obtain.

What runs on a fresh clone with **no keys at all**:

| | |
|---|---|
| The whole compiler and its 78 tests | `npm run check` — no database needed either |
| Drawing, folding, freezing a board | the type check that gates the hash |
| **Pass A of the review agent** | ~80% of comments, and the entire thesis |
| Applying answers, watching the board change | every mutation, including the five-node collapse |

Pass A is pure code with no model in it — that is the point of it. The claim
this project is making, that the review agent asks exactly the questions the
compiler would ask, is demonstrable start to finish without an API key.

What needs a key you supply:

| Key | Unlocks | Get it from |
|---|---|---|
| `ANTHROPIC_API_KEY` | Pass B (proposals from English notes) and the policy resolution loop | console.anthropic.com → API keys |
| `COMPOSIO_API_KEY` + `COMPOSIO_GMAIL_CONNECTION_ID` | fetching real messages | Composio dashboard, then the Gmail OAuth flow once |

`COMPOSIO_USER_ID` is not issued to anyone — it is a name you choose to
namespace connected accounts. Any stable string works.

Paste keys into `.env.local`. Re-running `npm run env:local` preserves them.

### What the other keys are for

`.env.example` lists every key the app reads, and `npm run env:local` writes
exactly that set — same keys, same order, same format. If the two ever drift,
`npm run doctor` says so.

| Key | Needed by |
|---|---|
| `DATABASE_URL` | Everything. The canvas, the review worker and the CLI all coordinate through these rows and never call each other directly. |
| `NEXT_PUBLIC_SUPABASE_URL` / `..._ANON_KEY` | The browser's Realtime subscription, so a running build streams its status without polling. `NEXT_PUBLIC_` is a Next.js convention meaning **inlined into the client bundle** — only browser-safe values may carry it. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server side only: the review worker and the CLI. It bypasses row-level security, so it must never be `NEXT_PUBLIC_`. |
| `ANTHROPIC_MODEL` | Pinned deliberately. Extraction runs through a model, so the eval suite's expected values only mean something against a fixed one. |
| `CHANNEL_MODE` | `capture` writes outbound sends to disk to be asserted against; `live` delivers them. Defaults to `capture` so a five-iteration heal loop can't send dozens of real emails. |

## Running it

Two processes, in two terminals. They never call each other — the canvas
inserts a row, the worker wakes on `LISTEN`, and the database is the only thing
between them.

```bash
npm run dev           # terminal 1 — canvas at http://localhost:3000
npm run worker        # terminal 2 — the review agent
```

The worker prints a line per round, which is the quickest way to see what the
compiler found:

```
review worker listening on review_runs
round 1 on 10000000-…-0001: 18 findings, 18 new, wrote 7 in 43ms
```

Without the worker the canvas still draws, freezes and reports findings — but
pressing **Review** queues a round nobody picks up, so no comments appear.

| | |
|---|---|
| Canvas | http://localhost:3000 |
| Supabase Studio | http://127.0.0.1:54323 — Table Editor, schema `public` |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |

Three boards are seeded. Start with **Inbound import receiving (draft)** — it is
deliberately drawn the way a domain expert actually draws it, so it does not
freeze, and it is what the review loop has something to say about.

## Verifying it works

One command. It proves the checkout end to end and tells you what to run for
anything that's broken:

```bash
npm run doctor
```

```
environment
  ✓ .env.local present                mode 600
  ✓ .env.local matches .env.example   13 keys
  ! COMPOSIO_API_KEY is empty         not needed yet — block 7

stack
  ✓ docker daemon is running
  ✓ database reachable                local
  ✓ schema applied                    8 tables
  ✓ boards seeded                     3 boards, 29 nodes, 38 edges
  ✓ LISTEN/NOTIFY fires               the review worker will wake on a queued run

code
  ✓ test suite passes                 78 tests
  ✓ no domain nouns in the engine
```

Keys you haven't filled in are warnings, not failures, and each says which
block needs it — so a fresh clone with no API keys still reports green for
everything that's actually built.

The `LISTEN/NOTIFY` line is worth understanding: it inserts a real row, waits
for the trigger to fire, and deletes it. If that silently stopped working the
review agent would simply never wake, and nothing else would look wrong.

Narrower checks, if you want them:

```bash
npm test              # the compiler suite and the example-board integration tests
npm run lint:nouns    # fails if a domain noun leaked into the engine
npm run check         # lint + typecheck + tests, no database needed
```

`npm run check` needs no database at all — the compiler is pure functions, so
its whole test suite runs on a fresh clone before you start anything.

## Everyday commands

```bash
supabase start        # bring the stack up
supabase stop         # take it down (data survives)
supabase stop --no-backup   # take it down and discard the data
npm run db:seed       # rebuild seed.sql from examples/ and reset the database
npm run env:local     # rewrite .env.local after recreating the stack
```

## When something is wrong

**Studio shows no tables.** Check you're at `127.0.0.1:54323` and not
supabase.com — this stack is entirely local and unlinked, so a cloud project
would correctly show nothing. In Table Editor, make sure the schema selector
says `public`. Hard-refresh if you reset the database while Studio was open.

**`Cannot connect to the Docker daemon`.** Docker Desktop isn't running. See
above.

**Ports already in use.** Another Supabase project is running. `supabase stop`
in that project, or change the ports in `supabase/config.toml`.

**`DATABASE_URL is not set`.** Run `npm run env:local`. It needs the stack up.
