"""The workflow that hosts a generated agent.

Deliberately thin. The agent's logic is a pure function over payloads; Temporal
supplies durability and nothing else, so this is the entire Temporal surface the
engine has.

Out of scope, and stated rather than half-built: the fail edge -- the outbound
send on failure, `workflow.wait_condition`, the correlated reply signal and the
scoped resume. `compiled.fail_handlers` is empty on every spec that ships here,
and a workflow that parked without a signal to wake it would be worse than one
that does not park.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from temporalio import workflow

with workflow.unsafe.imports_passed_through():
    from .activities import run_agent


@workflow.defn(name="ProcessWorkflow")
class ProcessWorkflow:
    @workflow.run
    async def run(self, request: dict[str, Any]) -> dict[str, Any]:
        return await workflow.execute_activity(
            run_agent,
            request,
            start_to_close_timeout=timedelta(minutes=15),
        )
