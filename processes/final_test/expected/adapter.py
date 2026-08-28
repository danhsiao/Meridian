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

One of the seven is NOT SCORED, and the reason is a property of the board rather
than of the runner. `coa_success` counts certificates that matched something,
and nothing on this board ever produces a verdict against a certificate --
`pol_2` judges the Batch that looks a certificate up, not the certificate
itself. Scoring it would mean inventing a check the operator never drew.

`failed_coa` WAS in that category and no longer is. The redrawn board makes Batch
its own artifact and lands `pol_2`'s verdict on it, so a batch fails exactly when
no certificate matches it -- which is what the label counts. It is now read as
`count:art_4:fail`.

That correction was caught by the heal skill reading this file against METRICS
below and finding they disagreed, which is worth recording: a stale docstring
made two failing cases look like agent bugs when they were a scoring question.
"""
from __future__ import annotations

from typing import Any

#: Metric -> how to read it out of a run.
#:
#: Node ids are this board's vocabulary and they moved when the board was
#: redrawn, so this table moved with them:
#:
#:   art_2  Invoice   art_3  CoA   art_4  Batch   art_5  Goods
#:
#: `art_4` used to mean Goods and now means Batch, which is exactly the kind of
#: silent remap that makes keeping the adapter in one file worth it.
METRICS: dict[str, str | None] = {
    "invoices_total": "count:art_2",
    "invoices_failed": "count:art_2:fail",
    "invoices_successful": "count:art_2:pass",
    "goods_failed": "count:art_5:fail",
    "coa_total": "count:art_3",
    # Now scoreable: pol_2 lands its verdict on Batch, and a batch fails exactly
    # when no certificate matches it. `coa_success` stays out -- it counts
    # certificates, and nothing on the board judges a certificate.
    "failed_coa": "count:art_4:fail",
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
UNSCORED_REASON = "no verdict target on art_3: nothing on the board judges a certificate, only the batch that looks one up"
