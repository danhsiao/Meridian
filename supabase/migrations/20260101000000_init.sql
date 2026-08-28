-- Autonomous Workflow Engine — initial schema.
-- The database is the bus: the browser never calls the review agent, the CLI
-- never calls the browser. Everything writes rows; Realtime pushes them.

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

-- Node ids are human-readable and board-local ('rec_inv'), so a global primary
-- key collides the moment a second board uses the same id. Composite instead.
create table nodes (
  map_id     uuid not null references process_maps(id) on delete cascade,
  id         text not null,                      -- 'rec_inv', never derived from label
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
  unique (map_id, from_node, to_node)
);
create index on edges (map_id, to_node);          -- badge counts, in-degree

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
  supersedes  text,                              -- a later decision invalidating an earlier one
  round       int not null,
  run_id      text references review_runs(id),

  code        text not null,                     -- the Finding code
  -- Two axes, not one. severity answers "does this block freeze"; rank answers
  -- "where does it sit in the queue". A structural correction is advisory but
  -- ranks above ordinary blocking findings, so one column cannot carry both.
  severity    text not null check (severity in ('blocking','advisory')),
  rank        text not null
              check (rank in ('precondition','structural','blocking','advisory')),
  pass        text not null check (pass in ('A','B')),
  binding     text not null check (binding in ('control','prompt','derived')),
  answer_kind text not null check (answer_kind in ('choice','text')),

  author_type text not null check (author_type in ('agent','user')),
  author_id   uuid references users(id),
  body        text not null,
  options     jsonb,                             -- computed, then relabelled by the model
  answer      jsonb,
  proposal    jsonb,                             -- a `derived` key's resolution, awaiting confirmation
  mutation    jsonb not null,                    -- a comment without one is a note
  status      text not null default 'open'
              check (status in ('open','answered','rejected','resolved')),
  created_at  timestamptz not null default now(),

  primary key (map_id, id),
  foreign key (map_id, node_id)    references nodes(map_id, id) on delete cascade,
  foreign key (map_id, edge_id)    references edges(map_id, id) on delete cascade,
  foreign key (map_id, parent_id)  references comments(map_id, id),
  foreign key (map_id, supersedes) references comments(map_id, id),

  -- Exactly one anchor, never zero. A diagnostic detached from its location is
  -- the thing the whole pin model exists to avoid.
  constraint one_anchor check (num_nonnulls(node_id, edge_id) = 1),
  -- A control question with no option set is an empty dropdown; that state is a
  -- precondition finding, never a comment.
  constraint control_has_options check (binding <> 'control' or options is not null),
  -- answer_kind is derived from binding, never chosen.
  constraint answer_kind_matches_binding check (
    (binding in ('control','derived') and answer_kind = 'choice') or
    (binding = 'prompt'               and answer_kind = 'text')
  ),
  -- A derived key must show her what it resolved to before she can confirm it.
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
  registry_version text not null,                -- additive registry bumps stay compilable
  spec             jsonb not null,               -- includes .compiled
  spec_hash        text not null,
  created_at       timestamptz not null default now(),
  unique (map_id, version)
);

-- Many builds per spec (re-runs, heal iterations), so the board needs an
-- explicit "latest". Kept separate from frozen_specs on purpose: the frozen
-- payload is immutable, so mutable build status lives elsewhere.
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

-- The review worker wakes on LISTEN rather than polling.
create or replace function notify_review_run() returns trigger as $$
begin
  perform pg_notify('review_runs', new.id);
  return new;
end;
$$ language plpgsql;

create trigger review_runs_notify
  after insert on review_runs
  for each row execute function notify_review_run();
