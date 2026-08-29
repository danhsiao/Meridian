"""`cli eval --process <id>` -- score an agent against its labels.

A command, not a skill. It is deterministic and there is nothing here for a
model to decide; making it a skill would add latency and non-determinism to the
one thing in the loop that has to be reproducible.

The report prints expected, actual, **and `extracted_state`** -- the values the
agent actually pulled. A count mismatch says something is wrong; "AALC 25063A "
next to "AALC25063A" says what, and that distinction is the whole reason the
heal skill can classify a failure before patching it.

Everything here works on a normalised shape. The suite's own format lives in
`processes/<id>/expected/adapter.py`, so a second process brings a different
label format by writing a sibling of that file and touching nothing here.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

from .fetch import refresh
from .paths import agent_dir, expected_dir, fixtures_dir, process_dir, reports_dir, spec_path


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_agent(process_id: str, agent: str):
    path = process_dir(process_id) / agent / "agent.py"
    if not path.exists():
        raise SystemExit(f"no agent at {path}. Run `cli gen --process {process_id}` first.")
    return _load_module(path, f"{process_id}_{agent}")


def _load_fixtures(process_id: str, replay: bool) -> list[dict[str, Any]]:
    """Score against the live channel by default; `--replay` pins the snapshot.

    Live is the default so that a mail which arrived since the last snapshot is
    in the report rather than absent from it. What it costs is stated plainly
    rather than hidden: a payload with no labelled case cannot be scored, so it
    lands in `unmatched_fixtures` and moves no metric. A run that fetches a
    genuinely new mail therefore shows the same pass count and one more
    unmatched id -- that line is the signal, not a warning to skim past.

    `--replay` is what the heal loop wants, and `--offline` implies it: two
    consecutive evals over a moving inbox cannot tell a patch that worked from
    an inbox that changed, which is the one comparison the loop exists to make.
    """
    if not replay:
        refresh(process_id)
    directory = fixtures_dir(process_id)
    if not directory.exists():
        raise SystemExit(
            f"no fixtures at {directory}. Drop --replay to fetch from the live channel."
        )
    return [json.loads(f.read_text()) for f in sorted(directory.glob("*.json"))]


def run_eval(
    process_id: str,
    agent: str = "agent",
    offline: bool = False,
    only: str | None = None,
    replay: bool = False,
) -> int:
    if offline:
        import os

        os.environ["EXTRACT_OFFLINE"] = "1"
        # Offline means "do not reach the network to extract". Reaching it to
        # fetch would honour the letter of that and not the point of it.
        replay = True

    adapter = _load_module(expected_dir(process_id) / "adapter.py", f"{process_id}_adapter")
    agent_module = _load_agent(process_id, agent)
    cases = adapter.load(json.loads((expected_dir(process_id) / "results.json").read_text()))
    fixtures = _load_fixtures(process_id, replay)

    scored_metrics = [m for m, source in adapter.METRICS.items() if source is not None]
    unscored = [m for m, source in adapter.METRICS.items() if source is None]

    report: dict[str, Any] = {
        "process_id": process_id,
        "agent": agent,
        "spec_hash": json.loads(spec_path(process_id).read_text())["spec_hash"],
        # Two reports with the same score are not comparable unless they read
        # the same payloads, and after this change that is no longer implied.
        "inbound": "replay" if replay else "live",
        "scored_metrics": scored_metrics,
        "unscored_metrics": {m: adapter.UNSCORED_REASON for m in unscored},
        "cases": [],
    }

    used: set[str] = set()
    passes = failures = skipped = 0

    for case in cases:
        if only and case["key"] != only:
            continue
        matched = [f for f in fixtures if adapter.matches(case["key"], f)]
        for f in matched:
            used.add(f["id"])

        if case["discard"]:
            # Counted as a pass regardless of output, but reported as skipped so
            # the discard is visible rather than silently green.
            skipped += 1
            passes += 1
            report["cases"].append(
                {"key": case["key"], "status": "skipped (discarded)", "fixtures": len(matched)}
            )
            print(f"  ~ {case['key']:<14} skipped (discarded by the label suite)", flush=True)
            continue

        if not matched:
            failures += 1
            report["cases"].append(
                {"key": case["key"], "status": "no fixture", "fixtures": 0}
            )
            print(f"  ✗ {case['key']:<14} no fixture matched this case")
            continue

        result = agent_module.run(matched, spec_path=str(spec_path(process_id)))
        actual = adapter.project(result["extracted_state"])
        diffs = {
            m: {"expected": case["expected"][m], "actual": actual.get(m)}
            for m in scored_metrics
            if m in case["expected"] and case["expected"][m] != actual.get(m)
        }
        ok = not diffs
        passes += ok
        failures += not ok
        report["cases"].append(
            {
                "key": case["key"],
                "status": "pass" if ok else "fail",
                "fixtures": len(matched),
                "expected": case["expected"],
                "actual": actual,
                "diffs": diffs,
                "outputs": result.get("outputs"),
                "extracted_state": result["extracted_state"],
            }
        )
        mark = "✓" if ok else "✗"
        print(f"  {mark} {case['key']:<14} {len(matched)} fixture(s)", flush=True)
        for metric, d in diffs.items():
            print(f"      {metric}: expected {d['expected']}, got {d['actual']}")

    unmatched = [f["id"] for f in fixtures if f["id"] not in used]
    report["unmatched_fixtures"] = unmatched
    report["score"] = {"passed": passes, "failed": failures, "skipped": skipped, "total": passes + failures}

    reports_dir(process_id).mkdir(parents=True, exist_ok=True)
    report_path = reports_dir(process_id) / "eval.json"
    report_path.write_text(json.dumps(report, indent=2, default=str))

    print()
    if unscored:
        print(f"  not scored: {', '.join(unscored)}")
        print(f"      {adapter.UNSCORED_REASON}")
    if unmatched:
        print(f"  {len(unmatched)} fixture(s) matched no labelled case")
    print(f"\n  {passes}/{passes + failures} ({skipped} discarded)   report: {report_path}")
    return 0 if failures == 0 else 1
