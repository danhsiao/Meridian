"""Temporal activity wrappers.

The generated agent's logic is a pure function over payloads. Everything
non-deterministic -- the model call, the network -- happens inside an activity,
which is what makes the workflow replayable.
"""
from __future__ import annotations

import importlib
import os
from typing import Any

from temporalio import activity


@activity.defn(name="run_agent")
async def run_agent(request: dict[str, Any]) -> dict[str, Any]:
    """Load a generated agent module by name and run it over some payloads.

    The module path arrives in the request rather than being imported at the
    top: the worker serves every process, and importing one of them here would
    make the runtime know a process exists.

    `payloads` may be None, and that is the ordinary case. The agent's channel
    node then resolves its own transport and fetches -- which is why this runs
    in an activity rather than the workflow, and why the timeout on it is
    generous.

    The two channel settings are applied to the environment here because the
    worker is a long-lived process serving many runs; they arrive per request so
    that one run's `--live` cannot leak into the next run's sends.
    """
    os.environ["CHANNEL_MODE"] = request.get("channel_mode", "capture")
    if request.get("capture_dir"):
        os.environ["CHANNEL_CAPTURE_DIR"] = request["capture_dir"]
    module = importlib.import_module(request["module"])
    return module.run(request.get("payloads"), spec_path=request["spec_path"])
