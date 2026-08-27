Autonomous Workflow Engine (Meridian Take-Home)

Author: Daniel Hsiao
Timeline: 48 Hours

1. The Objective

Goal: Build a two-phase AI platform that lets a non-technical process owner define a business process visually, then autonomously generates and self-heals a backend state machine that executes it. Demonstrated on inbound pharmaceutical import receiving.

The class of process this covers: information arrives from a channel, gets stored as an artifact, gets checked against rules, and produces an output. Loan file completeness, permit review, invoice matching, certified payroll audits, and import receiving are all the same shape.

There is no SOP. These processes live in one person's head and have never been written down. The canvas isn't a second opinion on an existing document — it's where the process gets written for the first time, and the frozen spec is the artifact that didn't exist before.

That determines what the review agent is for. It isn't reconciling two sources, because there's only one. Its job is getting one person's tacit knowledge complete enough to compile.

1.1 The Framing: An IDE for Business Workflows

A development environment where the source language is visual and the author is a domain expert rather than a programmer.

IDE concept	This system
Source code	The whiteboard
Language server	The AI review agent
Inline diagnostic	A comment anchored to a node or edge
Quick fix	The mutation attached to each comment
Type check	The five freeze predicates, run on Submit
Intermediate representation	The frozen spec, hashed and immutable
Compiler backend	The codegen agent
Runtime library	The hand-written agent skeleton
Execution	The Temporal worker
Test suite	The eval fixtures
Build ID	spec_hash

Each mapping carries a design decision.

Comments are diagnostics, so they live on the canvas. A compiler error names a line number because a diagnostic detached from its location is worth far less. This is why the loop is Figma-style pins, not a chat sidebar.

Comments carry their own fix. A compiler error says what's wrong; a language server offers a patch. Every comment declares its mutation at creation, so answering one is a structural edit rather than a note.

The loop runs until Pass A returns no findings and the five predicates pass — typically three or four rounds. The assignment's two-round minimum is the demo's lower bound, not a design limit. Convergence is structural: every comment carries a mutation that fills a required key or adds a missing edge, and the required-key set is finite per node.

Submit is a type check, not a save. Five predicates pass, or it fails naming the offending node IDs. x, y are stripped before hashing for the same reason a compiler ignores whitespace.

The spec is compiled, not interpreted. A compiled artifact has stack traces that point at lines, fixes that are reviewable diffs, and tests that are real tests. An interpreted graph surfaces errors inside the interpreter, has no type checker, and no review story.

Compilation is one direction. The self-heal constraints stop being policy and become structural: a failing test cannot edit the IR, for the same reason a linker cannot rewrite your source.

The skeleton is a runtime library. Generated code links against it. Rewriting it to pass a test is not a fix.

Where the analogy breaks

A compiler's source is complete when submitted; an error means the author made a mistake. Here the source is incomplete by nature — nobody wrote it down because nobody ever had to. The review agent isn't only checking, it's eliciting. The type checker interviews the author.

That's what justifies two rounds. Round one parses what she wrote. Round two type-checks what she meant, and only the second can surface "you said one certificate per batch — what happens if two arrive?", because the join that makes the question askable didn't exist until round one resolved.

The concession: the process owner can't edit a deployed agent. Changes route back through the canvas, regeneration, and deploy. That's the right trade where exceptions are the substance of the work — and easy to defend when the canvas is the document of record.

2. The End-to-End Workflow
She builds. Drags cards, names them, types field names, writes notes. No SOP to transcribe; she's describing her job.
She clicks Review. A review_runs row lands; a worker wakes on LISTEN.
The agent reviews. Two passes. Comments appear as pins on the cards they concern.
She answers. Each answer applies its mutation in one transaction — nodes appear, edges get drawn, fields fill in. The board changes because she answered, not because she dragged.
Round two. New structure means new questions, and questions round one couldn't ask.
She submits. Five predicates run. Fail names the nodes; pass writes an immutable hashed row and locks the board.
Codegen runs. Invoked manually from the CLI — Codex reads the spec and the skill file, emits Python against the skeleton.
Evals and self-heal. Ten fixtures, diff against labels, patch, re-run. Capped at five iterations.
She watches. The locked spec shows live status: generating → testing 7/10 → healing → built 10/10. No code, no diffs. Status and a score.

Steps 7 and 8 write to spec_builds; Realtime pushes each update to her browser. The CLI never calls the frontend.

3. Scope & Constraints

In Scope:

React whiteboard with 4 primitives (Channel, Artifact, Policy, Output). Design rule: don't add a primitive you can't explain to a non-engineer in one sentence.
AI review loop with structured comments, each carrying the exact spec change it applies.
Structural correction — the reviewer detects and fixes modeling mistakes, not just gaps. Five artifacts that should be five fields become one comment and one collapse.
CLI-driven (Claude Code/Codex) code generation and self-healing loop.
Temporal worker execution against 10 sample Composio emails.
Live build status on the locked spec.
The fail edge — outbound discrepancy email, durable wait, scoped resume. The capability that distinguishes this from a workflow builder.

Out of Scope:

Cross-board references. One whiteboard is one process; a frozen spec is self-contained.
Conflict resolution beyond last-write-wins when the same record arrives from two sources
Custom LLM nodes within primitives
Auto-layout, grouping, and list view for boards above ~15 cards
Production auth and role separation
4. System Architecture

Four zones: Interactive Canvas, Immutable Handoff, Zero-to-One Generation, One-to-N Self-Healing.

The database is the bus. The browser never calls the review agent, and the CLI never calls the browser. Everything writes rows; Realtime pushes them. That's what lets review take four seconds without blocking, and lets a five-minute build stream progress with no polling.

[Lucidchart link]

5. The Data Model (The Immutable Handoff)
The four primitives
Primitive	One sentence
Channel	A connection to the outside world — things arrive from it, get sent to it, or both.
Artifact	A typed thing with fields, pulled out of something unstructured or built from other artifacts.
Policy	A check over one or more artifacts that returns pass or fail.
Output	What gets computed at the end — verdicts from policies, values from artifacts.

Artifacts are entirely user-defined. No registry of known document types. label is free text, fields is a free-text array, any artifact can derive from any channel or any other artifact. The system ships no nouns.

What's fixed is the grammar: four node kinds, two policy kinds, five output functions, two failure modes. Each maps to a codegen template. Unlimited nouns, enumerated verbs.

Node vs. field

A thing is a node if another node has an edge to it. Fields are values named inside a node's config; nothing points at them.

A policy has an edge to Good and names hts in its required list. The edge makes Good a node. The mention doesn't make hts one — a verdict on "the HTS code" has no meaning; the good is missing a code.

Mechanical test: would this ever appear in the edges table? If yes, node. If it only ever appears inside some node's config, field.

Three meanings of artifact → artifact
Shape	Discriminator	Means
Containment	no config.on	child extracted from parent — Invoice contains Good
Join	config.on, one inbound artifact edge	two records matched, both stay separate
Merge	two or more inbound artifact edges	a new record built from several parents

Merge is derivable from in-degree — no extra column. It needs a pairing rule: three A's and four B's is twelve possible C's unless something says which pair. That's pair_on, or combine: "cross" | "collapse".

Rendering

The canvas draws what's surprising and folds what's obvious.

Thing	Drawn as
Containment edge	indented row inside the parent card
Policy reading one artifact	a row inside that card, counted in a badge
Policy reading two artifacts	its own box — it belongs to neither
Join edge	a line with the key on it
Merge	drawn — neither parent can host the other
Fail edge	a red line to the outbound channel

30 nodes render as ~4 cards. All 30 are in the spec regardless. The renderer may be lossy; the compiler may not:

js
compile(nodes, edges).nodes.length === nodes.length
Shared Registry

Grammar, not vocabulary. Requirements key off edge topology, so the same registry serves any industry.

json
{
  "channel": {
    "required": ["tool"],
    "required_if": { "has_outputs": ["match"], "has_inputs": ["request"] }
  },
  "artifact": {
    "required": ["fields"],
    "required_if": {
      "multiple_sources":                    ["identity_key"],
      "multiple_inbound_artifacts":          ["pair_on"],
      "sibling_artifacts_from_same_channel": ["source_hint"]
    },
    "optional": ["computed", "extraction_hint"]
  },
  "policy": {
    "required": ["kind", "on_fail"],
    "required_if": { "multiple_reads": ["verdict_on"] },
    "enums": {
      "kind": ["field_presence", "cross_reference"],
      "on_fail": ["halt", "flag_and_continue"]
    }
  },
  "output": {
    "required": ["rows"],
    "enums": { "function": ["count", "sum", "list", "copy", "verdict"] }
  }
}

The registry is the type system — what's required and what's valid. Codegen templates live in /skills/spec-to-agent/templates/, keyed on the same enums. Keeping them apart is what lets the registry stay free of target-language syntax.

source_hint is free text, required only when two artifacts derive from the same channel — at which point something has to say which attachment is which. It goes into the extraction prompt, not into a classification the system reasons about.

verdict_on is derivable for a single-read policy and only asked when a policy reads two artifacts.

Sample Frozen JSON Spec
json
{
  "spec_version": "1.0",
  "process_id": "shipment_receiving_001",
  "spec_hash": "sha256:7c1e…9b4f",

  "nodes": [
    { "id": "ch_a1", "kind": "channel", "label": "Pre-alert inbox",
      "config": { "tool": "composio.gmail",
                  "match": { "subject_patterns": ["Pre-Alert Documents",
                                                  "APL USA // PRE-ALERT DOCUMENTATION"] } } },

    { "id": "rec_inv", "kind": "artifact", "label": "Commercial invoice",
      "config": { "identity_key": "invoice_number",
                  "fields": ["invoice_number", "container_no"],
                  "source_hint": "attachment headed 'Commercial Invoice'" } },

    { "id": "rec_good", "kind": "artifact", "label": "Good",
      "config": { "fields": ["hts", "fda_product_code", "anda", "reg_no", "ndc"] } },

    { "id": "rec_batch", "kind": "artifact", "label": "Batch",
      "config": { "identity_key": "batch_number", "fields": ["batch_number"] } },

    { "id": "rec_coa", "kind": "artifact", "label": "Certificate of analysis",
      "config": { "identity_key": "batch_number", "fields": ["batch_number"],
                  "source_hint": "attachment headed 'Certificate of Analysis'" } },

    { "id": "rule_fields", "kind": "policy", "label": "Required fields present",
      "config": { "kind": "field_presence",
                  "required": ["hts", "fda_product_code", "anda", "reg_no", "ndc"],
                  "on_fail": "flag_and_continue" } },

    { "id": "rule_coa", "kind": "policy", "label": "Batch has certificate",
      "config": { "kind": "cross_reference",
                  "on_fail": "flag_and_continue", "verdict_on": "rec_batch" } },

    { "id": "ch_out", "kind": "channel", "label": "Discrepancy email",
      "config": { "tool": "composio.gmail",
                  "request": { "subject": "Discrepancy — invoice {rec_inv.invoice_number}",
                               "body": "Missing certificates for: {rec_batch.batch_number where fail}" } } },

    { "id": "out_res", "kind": "output", "label": "Shipment result",
      "config": { "rows": [
        { "label": "invoices_processed", "fn": "count", "of": "rec_inv" },
        { "label": "invoices_succeeded", "fn": "count", "of": "rec_inv", "where": "pass" },
        { "label": "invoices_failed",    "fn": "count", "of": "rec_inv", "where": "fail" },
        { "label": "goods_failed",       "fn": "count", "of": "rec_good", "where": "fail" },
        { "label": "batches_processed",  "fn": "count", "of": "rec_batch" },
        { "label": "batches_succeeded",  "fn": "count", "of": "rec_batch", "where": "pass" },
        { "label": "batches_failed",     "fn": "count", "of": "rec_batch", "where": "fail" },
        { "label": "failed_batch_ids",   "fn": "list",
          "of": "rec_batch.batch_number", "where": "fail" }
      ] } }
  ],

  "edges": [
    { "from": "ch_a1",       "to": "rec_inv",    "config": { "cardinality": "many" } },
    { "from": "ch_a1",       "to": "rec_coa",    "config": { "cardinality": "many" } },
    { "from": "rec_inv",     "to": "rec_good",   "config": { "cardinality": "many" } },
    { "from": "rec_inv",     "to": "rec_batch",  "config": { "cardinality": "many" } },
    { "from": "rec_batch",   "to": "rec_coa",    "config": { "on": "batch_number" } },
    { "from": "rec_good",    "to": "rule_fields","config": {} },
    { "from": "rec_batch",   "to": "rule_coa",   "config": {} },
    { "from": "rec_coa",     "to": "rule_coa",   "config": {} },
    { "from": "rule_fields", "to": "out_res",    "config": {} },
    { "from": "rule_coa",    "to": "out_res",    "config": {} },
    { "from": "rule_coa",    "to": "ch_out",
      "config": { "on": "fail",
                  "await": { "channel": "ch_a1", "correlate_on": "invoice_number" },
                  "rescope": ["rec_batch"], "max_attempts": 3,
                  "timeout": "P5D", "on_exhausted": "escalate" } }
  ],

  "provenance": { "comments": ["c_01", "c_02", "c_04", "c_08"] }
}

Every industry-specific noun lives in a label or a source_hint. The backend never concludes that rec_coa "is a Certificate of Analysis" — it knows it's keyed on batch_number, joined to Batch, read by a cross-reference. Meaning is position in the graph.

Edges

Any primitive can point to any other — no fixed Channel → Artifact → Policy → Output order. Fan-in from multiple channels, artifacts merging into a third, and a policy failure pointing back at an outbound channel are all expressible.

No kind column; derived from endpoint kinds at compile (channel→artifact = derive, artifact→policy = read, artifact→channel = input, policy→channel = outcome). Artifact→artifact resolves by the table above.

Four config keys do the load-bearing work:

identity_key (artifact) merges the same invoice arriving in two emails before any check runs. This is why deduplication isn't an Output concern — by the time you're counting, there's nothing left to dedupe.
cardinality (edge) tells codegen whether to emit a loop, and lets freeze catch an Output row using copy on something reachable only through a many edge.
pair_on (artifact, when merging) resolves which parent records combine.
verdict_on (policy, when reading two) names which artifact takes the failure, so goods_failed and invoices_failed stay distinguishable.

The fail edge makes the graph cyclic. Codegen strips fail edges, topologically sorts the rest for execution order and parallelism, then emits the stripped edges as Temporal signal handlers. The loop body is a DAG; the loop is control flow.

Table schema
sql
create table users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table process_maps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  title text not null,
  status text not null default 'draft' check (status in ('draft','frozen')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table nodes (
  id text primary key,                       -- 'rec_inv', never from label
  map_id uuid not null references process_maps(id) on delete cascade,
  kind text not null check (kind in ('channel','artifact','policy','output')),
  label text not null,                       -- codegen never reads this
  config jsonb not null default '{}',
  x int not null default 0,                  -- stripped before hashing
  y int not null default 0,
  updated_at timestamptz not null default now()
);
create index on nodes (map_id);

create table edges (
  id text primary key,
  map_id uuid not null references process_maps(id) on delete cascade,
  from_node text not null references nodes(id) on delete cascade,
  to_node   text not null references nodes(id) on delete cascade,
  config jsonb not null default '{}',
  unique (from_node, to_node)
);
create index on edges (map_id);
create index on edges (to_node);              -- badge counts, in-degree

create table review_runs (
  id text primary key,
  map_id uuid not null references process_maps(id) on delete cascade,
  round int not null,
  status text not null default 'queued'
         check (status in ('queued','running','done','failed')),
  created_at timestamptz not null default now()
);

create table comments (
  id text primary key,                       -- 'c_08'
  map_id uuid not null references process_maps(id) on delete cascade,
  node_id text references nodes(id) on delete cascade,
  edge_id text references edges(id) on delete cascade,
  parent_id  text references comments(id),   -- follow-up in thread
  supersedes text references comments(id),   -- invalidates an earlier resolution
  round int not null,
  comment_type text not null,
  author_type text not null check (author_type in ('agent','user')),
  author_id uuid references users(id),
  body text not null,
  answer_kind text not null check (answer_kind in ('choice','text')),
  options jsonb,
  answer jsonb,
  mutation jsonb not null,                   -- the spec change, written at creation
  status text not null default 'open'
         check (status in ('open','answered','rejected','resolved')),
  created_at timestamptz not null default now(),
  constraint one_anchor check (num_nonnulls(node_id, edge_id) <= 1)
);
create index on comments (map_id, status);
create index on comments (map_id, round);

create table frozen_specs (
  id uuid primary key default gen_random_uuid(),
  map_id uuid not null references process_maps(id) on delete cascade,
  version int not null,
  spec jsonb not null,
  spec_hash text not null,
  created_at timestamptz not null default now(),
  unique (map_id, version)
);

create table spec_builds (
  id uuid primary key default gen_random_uuid(),
  spec_id uuid not null references frozen_specs(id),
  status text not null default 'submitted'
         check (status in ('submitted','generating','testing','healing','built','failed')),
  iteration int not null default 0,
  tests_passed int,
  tests_total int,
  message text,
  updated_at timestamptz not null default now()
);

spec_builds is separate from frozen_specs on purpose — the frozen payload is immutable, so the mutable build status lives elsewhere. That's how "the spec never silently changes" survives having a live status attached to it.

comments.mutation is not null at the schema level: a comment without a mutation is a note, and a note changes nothing.

Freeze validation

Five predicates. Failure names the offending node IDs.

Every node reachable from a channel.
Every node reaches an output or an outbound channel.
The data subgraph (fail edges stripped) is acyclic.
Every merge target has a pairing rule; every multi-read policy has verdict_on.
Every comment is terminal — resolved or rejected, none open.

Then canonical() sorts keys and drops x, y, and the result is hashed.

6. The Review Loop

Because there's no SOP, the agent's job is completeness and correctness of the model, not reconciliation between documents.

Pass A — plain code, no model. Roughly 80% of comments.

Registry check — required keys empty, conditionals fired.

Graph check — orphan output, unreachable node, unbound policy, shared identity key with no join, merge target with no pair_on, siblings from one channel with no source_hint.

Structural correction — this is what keeps the board from bloating:

demote_to_field — an artifact with no fields, no children, and one artifact parent is a value pretending to be a record. Five boxes for HTS, FDA code, ANDA, Reg No, NDC become one comment and one collapse. The mutation includes rewire_policies, since any check attached to a demoted node has to move to the parent with the field name added to its required array.
compression — artifacts with identical fields and identical checks. Only identical; anything less is a deliberate split, and merging it would be wrong.
dead_node — no path to a terminal.

These rank near the top, above most missing-field questions. Fixing a modeling mistake early means round two isn't asking five separate questions about five nodes that shouldn't exist.


Pass B — the model. Only what requires reading English: a note describing something the board doesn't do, a failure with no defined next step.

Constraints: at most 7 comments per round, ranked by what blocks freeze. Every comment must carry a valid mutation or it's dropped before insert. Deduped on (type, anchor) against prior rounds. Stop condition is the five predicates passing.

The model picks from a closed set — missing_node, missing_edge, undeclared_join, missing_pairing, missing_field, cardinality, lifecycle, demote_to_field, promote_to_node, compression, dead_node — and writes the wording and button labels. It never designs the mutation; the type determines it. A question the system can't apply is a question it can't generate.

Memory has two shapes. The thread is for humans: parent_id chains follow-ups, supersedes marks a later decision invalidating an earlier one, and six months on every structural choice traces to a question, an answer, and a name. The decision log is for the model — one line per resolved mutation, so round two knows what round one settled without re-reading option arrays and timestamps.

The loop runs until Pass A returns no findings and the five predicates pass — typically three or four rounds. The assignment's two-round minimum is the demo's lower bound, not a design limit. Convergence is structural: every comment carries a mutation that fills a required key or adds a missing edge, and the required-key set is finite per node.

7. Evaluation & Self-Healing

Ten sample emails pulled once from the Composio inbox into /evals/fixtures/ and hand-labeled. On disk, not fetched live, so runs are deterministic. The frozen spec defines which metrics exist; the fixtures define their expected values.

Each stage writes to spec_builds, so the locked board shows live status without polling.

Trace interception. Structured report: fixture ID, expected vs. actual, and extracted_state — the values the agent actually pulled. A count mismatch says something is wrong; "AALC 25063A " next to "AALC25063A" says what.
Classification. Extraction failure or logic failure, before any patch.
Targeted patching. Localized diff inside the generated agent directory only.
Re-evaluation. Capped at 5 iterations, halting if failures aren't strictly decreasing. Every pass appends to /evals/heal-log.md.

The constraints below follow from compilation being one-directional, not from policy:

Never edit /evals/expected/ — the shortest path to a green suite and a useless agent.
Never edit the frozen spec — that's the IR; ambiguity means halt and surface, routing back to a new canvas comment.
Never weaken a rule carrying an # assumption c_NN comment — those encode human decisions from review.
Write only inside the generated agent directory. The skeleton is a runtime library.
State a root cause before producing a diff.

