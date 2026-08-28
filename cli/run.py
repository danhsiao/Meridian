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
from runtime.channels.capture import CaptureChannel
from runtime.channels.replay import ReplayChannel

from .paths import captured_dir, fixtures_dir, spec_path


def _payloads(process_id: str) -> list[dict[str, Any]]:
    directory = fixtures_dir(process_id)
    if not directory.exists():
        raise SystemExit(
            f"no fixtures at {directory}. Run `cli fetch --process {process_id} --live` first."
        )
    return [json.loads(f.read_text()) for f in sorted(directory.glob("*.json"))]


async def _execute(process_id: str, live: bool) -> dict[str, Any]:
    from temporalio.client import Client

    from runtime.workflow_base import ProcessWorkflow

    keys = env.require("TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", "TEMPORAL_TASK_QUEUE")
    client = await Client.connect(keys["TEMPORAL_ADDRESS"], namespace=keys["TEMPORAL_NAMESPACE"])
    return await client.execute_workflow(
        ProcessWorkflow.run,
        {
            "module": f"processes.{process_id}.agent",
            "spec_path": str(spec_path(process_id)),
            "payloads": _payloads(process_id),
        },
        id=f"{process_id}-{uuid.uuid4().hex[:8]}",
        task_queue=keys["TEMPORAL_TASK_QUEUE"],
    )


def run_process(process_id: str, live: bool = False) -> int:
    """Outbound sends default to captured. Live delivery is opt-in, per run.

    Defaulting the other way means one forgotten flag during a heal loop
    delivers dozens of real messages; defaulting to capture means the worst case
    is a demo where nothing arrives and you re-run with the flag. Fail safe in
    the direction that is recoverable.
    """
    if not live:
        print(f"  mode: capture -- outbound sends land in {captured_dir(process_id)}")
    else:
        print("  mode: LIVE -- outbound sends will be delivered")

    print("  start a worker first:  python -m runtime.worker")
    result = asyncio.run(_execute(process_id, live))
    print(json.dumps(result.get("outputs", {}), indent=2))
    return 0
