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

from .paths import fixtures_dir, spec_path


def inbound_channels(spec: Spec) -> list[str]:
    """Channels the process reads from: the ones freeze required a `match` on."""
    return [c for c in spec.of_primitive("channel") if spec.config(c).get("match") is not None]


def _slug(text: str, fallback: str) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z_.-]+", "-", text).strip("-")
    return cleaned[:80] or fallback


def fetch(
    process_id: str, limit: int = 25, live: bool = False, query: str | None = None
) -> int:
    """Snapshot every inbound channel.

    `query` overrides the board's `match` for this snapshot only. It exists
    because `match` is a `prompt`-bound key -- whatever the operator wrote in
    their own words -- and prose is not a provider query language. When it
    under-fetches, the honest response is an explicit, announced override at
    snapshot time and a finding for the next review round; the wrong response is
    an adapter that quietly second-guesses what the operator meant. The override
    is never written to the spec, so `spec_hash` is untouched.
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
    written = 0
    for channel_id in channels:
        config = spec.config(channel_id)
        channel = registry.resolve(config["tool"])
        match = config.get("match")
        if query is not None:
            print(f"{channel_id}: OVERRIDING the board's match for this snapshot only")
            print(f"    board: {match!r}")
            print(f"    used:  {query!r}")
            match = query
        else:
            print(f"{channel_id}: {config['tool']} <- {match!r}")
        for ordinal, payload in enumerate(channel.fetch(match, limit=limit), 1):
            name = f"{channel_id}-{ordinal:03d}-{_slug(payload.id, 'payload')}.json"
            (out_dir / name).write_text(json.dumps(payload.to_dict(), indent=2, default=str))
            parts = ", ".join(p.name for p in payload.parts) or "no parts"
            print(f"  {name}  [{parts}]")
            written += 1
    print(f"\n{written} payloads snapshotted to {out_dir}")
    return written
