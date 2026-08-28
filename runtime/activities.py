"""Temporal activity wrappers.

The generated agent's logic is a pure function over payloads. Everything
non-deterministic -- the model call, the network -- happens inside an activity,
which is what makes the workflow replayable.
"""
from __future__ import annotations

import importlib
from typing import Any

from temporalio import activity


@activity.defn(name="run_agent")
async def run_agent(request: dict[str, Any]) -> dict[str, Any]:
    """Load a generated agent module by name and run it over some payloads.

    The module path arrives in the request rather than being imported at the
    top: the worker serves every process, and importing one of them here would
    make the runtime know a process exists.
    """
    module = importlib.import_module(request["module"])
    return module.run(request["payloads"], spec_path=request["spec_path"])
