"""`cli run --process <id>` -- execute a generated agent through Temporal.

The workflow is a thin host: the agent's logic is a pure function over payloads,
and Temporal supplies durability and nothing else. The module it runs arrives in
the request rather than being imported by the worker, so one worker serves every
process and adding a process adds no worker configuration.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from runtime import env

from .paths import captured_dir, fixtures_dir, reports_dir, spec_path


def _payloads(process_id: str, replay: bool) -> list[dict[str, Any]] | None:
    """The `payloads` override for one run, or None to let the agent fetch.

    None is the default, and it is the whole point of this command: the agent's
    channel node calls `channels.inbound` and reaches Composio itself. Nothing
    in this file resolves a transport, and nothing in it names a provider.

    `--replay` hands the last snapshot over as the override instead. That is
    what the heal loop wants: extraction runs through a model, so if the inbox
    moves between iterations too, a result that flipped tells you nothing about
    whether the patch worked.
    """
    if not replay:
        return None
    directory = fixtures_dir(process_id)
    if not directory.exists():
        raise SystemExit(
            f"no fixtures at {directory}. Drop --replay and the agent will fetch for itself."
        )
    return [json.loads(f.read_text()) for f in sorted(directory.glob("*.json"))]


async def _execute(process_id: str, live: bool, replay: bool) -> dict[str, Any]:
    from temporalio.client import Client

    from runtime.workflow_base import ProcessWorkflow

    keys = env.require("TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", "TEMPORAL_TASK_QUEUE")
    client = await Client.connect(keys["TEMPORAL_ADDRESS"], namespace=keys["TEMPORAL_NAMESPACE"])
    return await client.execute_workflow(
        ProcessWorkflow.run,
        {
            "module": f"processes.{process_id}.agent",
            "spec_path": str(spec_path(process_id)),
            "payloads": _payloads(process_id, replay),
            # Send delivery travels in the request because the activity runs in
            # the worker, a different process that never saw this command's
            # flags. A `--live` that only set an environment variable here would
            # be silently ignored on the far side.
            "channel_mode": "live" if live else "capture",
            "capture_dir": str(captured_dir(process_id)),
        },
        id=f"{process_id}-{uuid.uuid4().hex[:8]}",
        task_queue=keys["TEMPORAL_TASK_QUEUE"],
    )


def run_process(process_id: str, live: bool = False, replay: bool = False) -> int:
    """The two directions default opposite ways, and the asymmetry is the point.

    **Inbound defaults to live.** Reading is idempotent, and a run that reports
    on a stale snapshot is quietly wrong in a way nobody notices -- the numbers
    look plausible, they are just about last week's inbox. `--replay` opts out.

    **Outbound defaults to captured.** Sending is not idempotent. One forgotten
    flag during a heal loop delivers dozens of real messages; the worst case of
    the other default is a demo where nothing arrives and you re-run with
    `--live`. Fail safe in the direction that is recoverable.
    """
    if replay:
        print(f"  inbound: replay -- last snapshot in {fixtures_dir(process_id)}")
    else:
        print("  inbound: live -- the agent's channel node fetches for itself")
    if not live:
        print(f"  outbound: capture -- sends land in {captured_dir(process_id)}")
    else:
        print("  outbound: LIVE -- sends will be delivered")

    result = asyncio.run(_execute(process_id, live, replay))

    # The run is the artifact, so it lands on disk next to the eval report
    # rather than only on a terminal that scrolls away.
    reports_dir(process_id).mkdir(parents=True, exist_ok=True)
    path = reports_dir(process_id) / "run.json"
    path.write_text(json.dumps(result, indent=2, default=str))

    print(json.dumps(result.get("outputs", {}), indent=2))
    records = result.get("extracted_state", {}).get("records", {})
    print("\n  records: " + ", ".join(f"{n}={len(r)}" for n, r in records.items()))
    print(f"  written: {path}")
    return 0
