"""Snapshot a channel to disk.

Generic by construction: the board's `tool` resolves through the runtime
dispatch table, so a process whose channel is `http.get` snapshots exactly the
same way. Nothing here knows what arrives.

Snapshot once, replay from disk. The far end is not changing, extraction runs
through a model, and fetching live on every iteration makes it impossible to
tell whether a result flipped because a patch worked or because the inbox did.
"""
from __future__ import annotations

import json
import re

from runtime.channels import registry
from runtime.spec import Spec

from .paths import fixtures_dir, queries_path, spec_path


def inbound_channels(spec: Spec) -> list[str]:
    """Channels the process reads from: the ones freeze required a `match` on."""
    return [c for c in spec.of_primitive("channel") if spec.config(c).get("match") is not None]


def saved_queries(process_id: str) -> dict[str, str]:
    path = queries_path(process_id)
    return json.loads(path.read_text()) if path.exists() else {}


def _remember_query(process_id: str, channels: list[str], query: str) -> None:
    """Persist a working `--query` so later automatic refreshes reuse it.

    Without this the override is a property of one typed command, and every
    `eval` or `run` afterwards goes back to the board's prose `match` and
    re-discovers that it fetches nothing. The operator would have to remember to
    type `fetch --query` before every run, which is the chore this whole change
    was meant to remove.

    It is remembered, not inferred: the file is written only when a human passed
    `--query`, and `cli fetch` with no override still exercises the board's own
    match so the underspecified `match` stays visible as a finding.
    """
    saved = saved_queries(process_id)
    saved.update({c: query for c in channels})
    queries_path(process_id).write_text(json.dumps(saved, indent=2))
    print(f"  remembered this query for later refreshes: {queries_path(process_id)}")


def _slug(text: str, fallback: str) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z_.-]+", "-", text).strip("-")
    return cleaned[:80] or fallback


def fetch(
    process_id: str,
    limit: int = 25,
    live: bool = False,
    query: str | None = None,
    use_saved: bool = False,
) -> int:
    """Snapshot every inbound channel.

    `query` overrides the board's `match` for this snapshot only. It exists
    because `match` is a `prompt`-bound key -- whatever the operator wrote in
    their own words -- and prose is not a provider query language. When it
    under-fetches, the honest response is an explicit, announced override at
    snapshot time and a finding for the next review round; the wrong response is
    an adapter that quietly second-guesses what the operator meant. The override
    is never written to the spec, so `spec_hash` is untouched.

    A working override is remembered in `queries.json` beside the spec, because
    `refresh` runs unattended before every eval and run and would otherwise fall
    back to the prose `match` and fetch nothing. `use_saved` is what those
    callers pass; a human typing `cli fetch` with no `--query` still exercises
    the board's own match, so an underspecified `match` stays visible.
    """
    spec = Spec.load(spec_path(process_id))
    channels = inbound_channels(spec)
    if not channels:
        raise SystemExit(f"{process_id} has no inbound channel to fetch from")
    if not live:
        raise SystemExit(
            "fetch reaches a real transport. Pass --live to confirm, so the flag is "
            "never the thing you forgot."
        )

    out_dir = fixtures_dir(process_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    saved = saved_queries(process_id)
    written = 0
    for channel_id in channels:
        config = spec.config(channel_id)
        channel = registry.resolve(config["tool"])
        match = config.get("match")

        override = query if query is not None else (saved.get(channel_id) if use_saved else None)
        if override is not None:
            source = "typed" if query is not None else f"remembered in {queries_path(process_id).name}"
            print(f"{channel_id}: OVERRIDING the board's match ({source})")
            print(f"    board: {match!r}")
            print(f"    used:  {override!r}")
            match = override
        else:
            print(f"{channel_id}: {config['tool']} <- {match!r}")

        # Fetch fully before touching disk. `match` is prose the operator wrote,
        # not a provider query language, so an empty result is a routine outcome
        # here rather than an exceptional one -- and clearing first would mean a
        # `match` that stopped matching silently deletes the snapshot it failed
        # to replace. That was survivable while `fetch` was something a human
        # typed; it is not, now that every `eval` and `run` calls it.
        fetched = list(channel.fetch(match, limit=limit))
        if not fetched:
            print(
                f"{channel_id}: 0 payloads -- KEEPING the previous snapshot.\n"
                f"    The board's match returned nothing. Re-run `cli fetch --process "
                f"{process_id} --live --query ...`\n"
                f"    with a provider query, and file a finding against the board's match."
            )
            continue

        # A snapshot replaces; it does not accumulate. Without this, a re-fetch
        # against a changed inbox leaves the previous run's payloads on disk
        # under names the new run never writes, and the eval silently scores a
        # mixture of two snapshots. Clearing only this channel's files keeps a
        # multi-channel process's other snapshots intact.
        stale = sorted(out_dir.glob(f"{channel_id}-*.json"))
        for path in stale:
            path.unlink()
        if stale:
            print(f"{channel_id}: cleared {len(stale)} payload(s) from the previous snapshot")

        for ordinal, payload in enumerate(fetched, 1):
            name = f"{channel_id}-{ordinal:03d}-{_slug(payload.id, 'payload')}.json"
            (out_dir / name).write_text(json.dumps(payload.to_dict(), indent=2, default=str))
            parts = ", ".join(p.name for p in payload.parts) or "no parts"
            print(f"  {name}  [{parts}]")
            written += 1
    if query is not None and written:
        _remember_query(process_id, channels, query)
    print(f"\n{written} payloads snapshotted to {out_dir}")
    return written


def refresh(process_id: str, limit: int = 25) -> int:
    """Re-snapshot every inbound channel immediately before an agent runs.

    `cli run` and `cli eval` call this by default, so an agent sees the inbox as
    it is now rather than as it was when someone last remembered to snapshot it.
    A mail that arrived five minutes ago is in the run; nobody has to know that
    a separate `fetch` step exists.

    Two differences from `fetch()` itself, both deliberate:

    A process with no inbound channel is not an error here. `fetch` is an
    explicit request to snapshot and has nothing to do if there is no channel;
    `refresh` is a step inside a larger command, and a process that reads no
    channel simply has nothing to refresh.

    `--live` is not required. The flag exists on `fetch` so that reaching a real
    transport is never the thing you forgot -- but a caller that reached here
    already decided to run against the live inbox, and asking twice would only
    train the reflex to pass the flag everywhere.
    """
    spec = Spec.load(spec_path(process_id))
    if not inbound_channels(spec):
        return 0
    print(f"  refreshing fixtures from the live channel ({process_id})")
    return fetch(process_id, limit=limit, live=True, use_saved=True)
