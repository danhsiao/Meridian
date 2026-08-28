"""Parse the required subset of the environment, and exit naming what's missing.

Validated at startup, not at first use. A five-minute run that dies on iteration
three because one key was blank is the same lost hour as an auth wall.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

_LOADED = False


def load(dotenv_path: str | Path = ".env.local") -> None:
    global _LOADED
    if _LOADED:
        return
    path = Path(dotenv_path)
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())
    _LOADED = True


def require(*names: str) -> dict[str, str]:
    """Return the named variables, or exit listing every one that is missing."""
    load()
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        print(
            "Missing required environment variables:\n"
            + "\n".join(f"  {n}" for n in missing)
            + "\n\nCopy .env.example to .env.local and fill these in.",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return {n: os.environ[n] for n in names}


def get(name: str, default: str | None = None) -> str | None:
    load()
    return os.environ.get(name, default)


def mode() -> str:
    """`capture` or `live`. Defaults to capture: the failure that is recoverable."""
    return (get("CHANNEL_MODE", "capture") or "capture").lower()
