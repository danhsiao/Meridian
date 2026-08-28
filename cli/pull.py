"""Bring a frozen spec down from the bus onto disk.

The database is the bus; `processes/<id>/spec.json` is the committed copy that
codegen, the eval runner and the heal loop all read. Pulling by hash rather than
by board keeps the file and the row provably the same artifact.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
from typing import Any

from runtime import env

from .paths import PROCESSES, spec_path


def _psql(sql: str) -> str:
    url = env.require("DATABASE_URL")["DATABASE_URL"]
    result = subprocess.run(
        ["psql", url, "-At", "-c", sql], capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


def canonical(spec: dict[str, Any]) -> str:
    """The same canonical form freeze hashes: sorted keys, no layout, no clock."""
    drop = {"x", "y", "updated_at", "created_at"}

    def strip(value: Any) -> Any:
        if isinstance(value, dict):
            return {k: strip(v) for k, v in sorted(value.items()) if k not in drop}
        if isinstance(value, list):
            return [strip(v) for v in value]
        return value

    return json.dumps(strip({k: v for k, v in spec.items() if k != "spec_hash"}), sort_keys=True, separators=(",", ":"))


def list_specs() -> list[dict[str, Any]]:
    rows = _psql(
        "select f.spec_hash, f.spec->>'process_id', m.title, f.created_at "
        "from frozen_specs f join process_maps m on m.id = f.map_id order by f.created_at"
    )
    out = []
    for line in rows.splitlines():
        parts = line.split("|")
        if len(parts) >= 4:
            out.append(
                {"spec_hash": parts[0], "process_id": parts[1], "title": parts[2], "created_at": parts[3]}
            )
    return out


def pull(spec_hash: str, process_id: str | None = None) -> str:
    # Accept a bare digest or a fully-qualified "sha256:..." -- the prefix is an
    # encoding detail of the hash, not part of how anyone refers to a build.
    needle = spec_hash.split(":")[-1]
    raw = _psql(
        "select spec::text from frozen_specs "
        f"where split_part(spec_hash, ':', 2) like '{needle}%' limit 1"
    )
    if not raw:
        raise SystemExit(f"no frozen spec matching {spec_hash!r}")
    spec = json.loads(raw)
    process_id = process_id or spec["process_id"]
    path = spec_path(process_id)
    path.parent.mkdir(parents=True, exist_ok=True)

    # A process directory is an importable package, because the Temporal
    # activity loads a generated agent by dotted module path. Without this
    # marker `cli run` dies on ModuleNotFoundError -- and it dies inside a
    # workflow activity, which is a long way from the command that caused it.
    # Written here rather than by `cli gen` so the directory is well-formed from
    # the moment it exists.
    (path.parent / "__init__.py").touch(exist_ok=True)
    (PROCESSES / "__init__.py").touch(exist_ok=True)

    path.write_text(json.dumps(spec, indent=2, sort_keys=True) + "\n")
    print(f"pulled {spec['spec_hash']} -> {path.relative_to(path.parents[2])}")
    return process_id
