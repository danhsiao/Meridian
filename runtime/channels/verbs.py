"""The channel verbs generated code calls. The integration, in the agent.

Every other runtime module is a pure function over data already in hand:
`extract` reads a payload, `relations` compares values, `outputs` shapes rows.
Channels are the one place the process touches the outside world, and for a
while that was reason enough to keep them out of the generated agent and let the
CLI pre-fetch. That was the wrong line to draw.

A `channel` node is a node. The board draws it, `freeze` compiles it, and
`topo_order` names it in position. A generated agent that walks the topo order
and emits a *comment* for one of its nodes is not walking the topo order -- it
is walking the part of it someone else did not already handle. The board says
"this process reads Gmail"; the agent should be the artifact that says so too.

So these are verbs, on the same footing as `extract` and `present`. The agent
calls `inbound` at its channel node and gets payloads. What is on the other end
-- Composio, HTTP, a provider not written yet -- resolves through the registry
from the spec's own `tool` string, so this module names no provider and neither
does the generated code.

## The one thing the caller still decides

`inbound` takes `given`. When it is not None, those payloads are returned as-is
and nothing is fetched.

That exists for `cli eval`, and for exactly one reason: the suite scores one
labelled case at a time and has to hand the agent *that case's* payloads. An
agent that always fetched its own inbox would get all of them on every case and
per-case scoring would be impossible. `given` is also what `--replay` rides on,
which is what makes a heal loop's two runs comparable.

Note what `given` is *not*. It is not the CLI owning the integration -- pass
nothing and the agent connects on its own. It is an override, and it is the
narrowest one that keeps the eval harness able to do its job.
"""
from __future__ import annotations

from typing import Any

from .. import env
from ..payload import Payload
from ..spec import Spec
from . import registry
from .base import Sent
from .capture import CaptureChannel


def inbound(spec: Spec, node_id: str, given: Any = None, limit: int = 25) -> list[Payload]:
    """Payloads for a channel node: the ones handed in, or a live fetch.

    A `queries.json` beside the spec overrides the board's `match` for the
    fetch. That file exists because `match` is a `prompt`-bound key -- prose an
    operator wrote in their own words -- and prose is not a provider query
    language. Demoboard's reads "Emails that has the subject line ... belong in
    inbox", which Gmail answers with nothing.

    The override is honoured here, and not only in `cli fetch`, because the
    agent now does its own fetching: an override the CLI applied and the agent
    did not would mean the two paths silently read different inboxes.
    """
    if given is not None:
        return [Payload.from_dict(p) if isinstance(p, dict) else p for p in given]
    config = spec.config(node_id)
    match = spec.sidecar("queries.json").get(node_id, config.get("match"))
    return registry.resolve(config["tool"]).fetch(match, limit=limit)


def outbound(spec: Spec, node_id: str, body: Any) -> Sent:
    """Deliver one rendered body through a channel node, or capture it to disk.

    The request is assembled from the node's own config, and keys the board did
    not supply come through as None rather than being invented here. On the one
    outbound board that exists today `config` carries `describes` and `request`
    as prose and names no recipient, so `recipient_email` is None and the
    captured file says so in as many words. That is the intended behaviour: a
    missing address is a finding against the board, and an adapter that guessed
    at one would deliver mail to an address nobody wrote down.
    """
    config = spec.config(node_id)
    request = {
        "recipient_email": config.get("to"),
        "subject": config.get("subject"),
        "body": body,
    }
    channel = registry.resolve(config["tool"])
    if env.mode() == "live":
        return channel.send(request)
    return CaptureChannel(channel, env.get("CHANNEL_CAPTURE_DIR", "captured")).send(request)
