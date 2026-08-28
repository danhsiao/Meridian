"""Parse the required subset of the environment, and exit naming what's missing.

Validated at startup, not at first use. A five-minute run that dies on iteration
three because one key was blank is the same lost hour as an auth wall.

Two rules that exist because both were paid for during the build:

**`.env.local` wins over ambient shell state.** A stale `COMPOSIO_API_KEY` left
exported in a shell silently shadowed the working one in the file, and the
result was a 401 twenty minutes after the same call had succeeded. The checkout
is the authority on its own credentials; the shell is not.

**Every credential is announced, masked, when it loads.** One line at startup
naming which key is in play turns the next auth failure into a diagnosis rather
than an investigation.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

#: Variables worth announcing. Not everything -- an address is visible in the
#: error it causes; a key is not.
ANNOUNCE = ("COMPOSIO_API_KEY", "COMPOSIO_USER_ID", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL",
            "TEMPORAL_ADDRESS", "TEMPORAL_TASK_QUEUE", "CHANNEL_MODE")

_LOADED = False
_ANNOUNCED = False


def mask(value: str | None) -> str:
    """Enough to tell two credentials apart, never enough to use one."""
    if not value:
        return "(unset)"
    if len(value) <= 12:
        return f"{value[:2]}…{value[-2:]} ({len(value)} chars)"
    return f"{value[:6]}…{value[-4:]} ({len(value)} chars)"


def load(dotenv_path: str | Path = ".env.local") -> None:
    """Read `.env.local` into the environment, overriding what is already there."""
    global _LOADED
    if _LOADED:
        return
    path = Path(dotenv_path)
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[1] / path
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            value = value.strip().strip('"').strip("'")
            if value:
                os.environ[key.strip()] = value
    _LOADED = True


def announce(stream=sys.stderr) -> None:
    """Print, once, which credentials are actually in play."""
    global _ANNOUNCED
    if _ANNOUNCED:
        return
    load()
    _ANNOUNCED = True
    print("env:", ", ".join(f"{n}={mask(os.environ.get(n))}" for n in ANNOUNCE), file=stream)


def require(*names: str) -> dict[str, str]:
    """Return the named variables, or exit listing every one that is missing."""
    load()
    announce()
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
