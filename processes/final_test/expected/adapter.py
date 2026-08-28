"""The label adapter -- the one file that knows this suite's format.

Everything else in the eval runner compares a normalised shape, so a second
process can bring a different label format by writing a sibling of this file and
touching nothing in `cli/`.

It does two jobs:

**Grouping.** The labels are keyed by shipment, the fixtures are messages, and
the two do not correspond one-to-one -- one shipment can arrive as two forwards
of the same documents. Grouping is exact string search for the labelled
identifier across the payload's subject, body and attachment names; no model,
so the mapping is deterministic and cannot drift between runs.

**Projection.** RunState -> the seven metric names the suite uses.

Two of the seven are NOT SCORED, and the reason is a property of the board
rather than of the runner. `failed_coa` and `coa_success` describe certificates
that matched nothing -- the reverse direction of the cross-reference. The board
wires `pol_2`'s verdict onto `art_2` only, so nothing on it ever produces a
verdict against `art_3`, and there is no honest way to read those two numbers
out of a run of this spec. Scoring them would mean inventing a check the
operator never drew. They are reported as `out of scope (no verdict target on
art_3)` and are a finding for the next review round, not a bug in the agent.
"""
from __future__ import annotations

from typing import Any

#: Metric -> how to read it out of a run.
#: `None` means the board produces no such number; the runner reports it and
#: does not score it.
METRICS: dict[str, str | None] = {
    "invoices_total": "count:art_2",
    "invoices_failed": "count:art_2:fail",
    "invoices_successful": "count:art_2:pass",
    "goods_failed": "count:art_4:fail",
    "coa_total": "count:art_3",
    "failed_coa": None,
    "coa_success": None,
}


def load(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """Suite format -> the runner's normalised shape."""
    cases = []
    for row in raw["shipments"]:
        cases.append(
            {
                "key": row["shipment_no"],
                "discard": bool(row.get("discard")),
                "expected": {k: row[k] for k in METRICS if k in row},
            }
        )
    return cases


def matches(case_key: str, payload: dict[str, Any]) -> bool:
    """Does this fixture belong to this labelled case?"""
    haystack = " ".join(
        [
            payload.get("text", "") or "",
            " ".join(str(v) for v in (payload.get("meta") or {}).values()),
            " ".join(p.get("name", "") for p in payload.get("parts", [])),
            " ".join(p.get("text", "") or "" for p in payload.get("parts", [])),
        ]
    )
    return case_key in haystack


def project(state: dict[str, Any]) -> dict[str, Any]:
    """Extracted state -> {metric: value}, with the unscoreable ones as None."""
    records = state.get("records", {})
    verdicts = state.get("verdicts", [])
    failed = {(v["node_id"], v["record_id"]) for v in verdicts if not v["ok"]}
    judged = {(v["node_id"], v["record_id"]) for v in verdicts}

    def count(node_id: str, where: str | None = None) -> int:
        rows = records.get(node_id, [])
        if where == "fail":
            return sum(1 for r in rows if (node_id, r["record_id"]) in failed)
        if where == "pass":
            return sum(
                1
                for r in rows
                if (node_id, r["record_id"]) in judged and (node_id, r["record_id"]) not in failed
            )
        return len(rows)

    out: dict[str, Any] = {}
    for metric, source in METRICS.items():
        if source is None:
            out[metric] = None
            continue
        _, node_id, *rest = source.split(":")
        out[metric] = count(node_id, rest[0] if rest else None)
    return out


#: Printed by the runner so the exclusion is visible in the report rather than
#: buried in this file.
UNSCORED_REASON = "no verdict target on art_3: the board never checks a certificate against an invoice"
