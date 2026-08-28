"""cli fetch | pull | specs | gen | eval | run"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cli", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("specs", help="list frozen specs on the bus")

    p = sub.add_parser("pull", help="copy a frozen spec onto disk")
    p.add_argument("--spec", required=True, help="spec hash, or a unique prefix of one")
    p.add_argument("--process", help="override the process id the spec names")

    p = sub.add_parser("fetch", help="snapshot a process's inbound channel to fixtures/")
    p.add_argument("--process", required=True)
    p.add_argument("--limit", type=int, default=25)
    p.add_argument("--live", action="store_true", help="required: this reaches a real transport")
    p.add_argument(
        "--query",
        help="override the board's match for this snapshot only; never written to the spec",
    )

    p = sub.add_parser("gen", help="generate an agent from a frozen spec")
    p.add_argument("--process", required=True)
    p.add_argument("--spec", help="spec hash to check against the on-disk spec")

    p = sub.add_parser("eval", help="score a process's agent against its labels")
    p.add_argument("--process", required=True)
    p.add_argument("--agent", default="agent", help="module directory under processes/<id>/")
    p.add_argument("--offline", action="store_true", help="fail rather than call the model")
    p.add_argument("--only", help="score one fixture only, by label key")

    p = sub.add_parser("run", help="run a process through the Temporal worker")
    p.add_argument("--process", required=True)
    p.add_argument("--live", action="store_true", help="deliver outbound sends for real")

    args = parser.parse_args(argv)

    if args.command == "specs":
        from .pull import list_specs

        for row in list_specs():
            print(f"{row['spec_hash'][:23]}  {row['process_id']:<24} {row['title']}")
        return 0

    if args.command == "pull":
        from .pull import pull

        pull(args.spec, args.process)
        return 0

    if args.command == "fetch":
        from .fetch import fetch

        fetch(args.process, limit=args.limit, live=args.live, query=args.query)
        return 0

    if args.command == "gen":
        from .gen import gen

        return gen(args.process, args.spec)

    if args.command == "eval":
        from .evaluate import run_eval

        return run_eval(args.process, agent=args.agent, offline=args.offline, only=args.only)

    if args.command == "run":
        from .run import run_process

        return run_process(args.process, live=args.live)

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
