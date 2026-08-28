"""One worker, every process.

Which module it runs is whichever generated agent the request names, so adding a
process adds no worker configuration.
"""
from __future__ import annotations

import asyncio

from temporalio.client import Client
from temporalio.worker import Worker

from . import env
from .activities import run_agent
from .workflow_base import ProcessWorkflow


async def main() -> None:
    keys = env.require("TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", "TEMPORAL_TASK_QUEUE")
    client = await Client.connect(
        keys["TEMPORAL_ADDRESS"], namespace=keys["TEMPORAL_NAMESPACE"]
    )
    worker = Worker(
        client,
        task_queue=keys["TEMPORAL_TASK_QUEUE"],
        workflows=[ProcessWorkflow],
        activities=[run_agent],
    )
    print(f"worker listening on {keys['TEMPORAL_TASK_QUEUE']}")
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
