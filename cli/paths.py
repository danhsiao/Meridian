"""Where a process's files live.

The only module that knows the `processes/<id>/` layout. Everything under that
directory is domain content and is the one place on disk where it is legal.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROCESSES = ROOT / "processes"


def process_dir(process_id: str) -> Path:
    return PROCESSES / process_id


def spec_path(process_id: str) -> Path:
    return process_dir(process_id) / "spec.json"


def fixtures_dir(process_id: str) -> Path:
    return process_dir(process_id) / "fixtures"


def expected_dir(process_id: str) -> Path:
    return process_dir(process_id) / "expected"


def agent_dir(process_id: str) -> Path:
    return process_dir(process_id) / "agent"


def captured_dir(process_id: str) -> Path:
    return process_dir(process_id) / "captured"


def reports_dir(process_id: str) -> Path:
    return process_dir(process_id) / "reports"


def known_processes() -> list[str]:
    if not PROCESSES.exists():
        return []
    return sorted(p.name for p in PROCESSES.iterdir() if (p / "spec.json").exists())
