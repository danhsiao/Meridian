"""The label adapter for `demoboard` -- the one file that knows this suite's
format AND this board's vocabulary.

Sibling of `processes/final_test/expected/adapter.py`. The label file is
byte-identical; what differs is the metric table below, because the board was
redrawn again and the node ids moved again.

**All seven metrics are scored on this board.** Two of them are only scoreable
because of a propagation, which is worth spelling out:

`compiled.verdict_targets` on this board is `{pol_1: art_5, pol_2: art_2}` --
Code Check judges Goods, Cross Validation judges CoAs. Nothing judges an
Invoice directly. But `compiled.propagations` carries `art_5`'s verdict up to
`art_3` along `e_7` (the contain edge from Invoices to Goods), so an invoice
fails exactly when one of its goods fails. That is what makes
`invoices_failed` and `invoices_successful` readable off `art_3`.

`pol_2` reads `art_2.Batch No` against `art_4.Batch No` and lands its verdict
on `art_2`: a certificate passes when a batch matches it and fails when none
does, which is exactly what the labels count.

The arithmetic agrees on all eleven labelled shipments:
`coa_success + failed_coa == coa_total` and
`invoices_successful + invoices_failed == invoices_total`. Both pairs
partition, so each belongs on the single node named above.

Derived from `spec.json`, not by fitting numbers to output -- an adapter tuned
until the counts line up is an adapter that can no longer fail.
"""
from __future__ import annotations

from typing import Any

#: Metric -> how to read it out of a run.
#:
#: This board's vocabulary, which is NOT the previous board's:
#:
#:   art_2  CoAs   art_3  Invoices   art_4  Batches   art_5  Goods
#:
#: Every artifact id moved. `art_2` went from Invoice to CoAs, `art_3` from
#: Batch to Invoices, `art_4` from Goods to Batches, `art_5` from CoAs to
#: Goods. Reading a metric off the wrong node is silent -- the counts come back
#: plausible and wrong -- which is why this table lives beside the labels and
#: not inside the runner.
#:
#: Note that `art_4` (Batches) is not read by any metric. The labels count
#: invoices, goods and certificates; the board's batches exist to give `pol_2`
#: something to match a certificate against.
METRICS: dict[str, str | None] = {
    "invoices_total": "count:art_3",
    "invoices_failed": "count:art_3:fail",
    "invoices_successful": "count:art_3:pass",
    "goods_failed": "count:art_5:fail",
    "coa_total": "count:art_2",
    "failed_coa": "count:art_2:fail",
    "coa_success": "count:art_2:pass",
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


#: Printed by the runner so an exclusion is visible in the report rather than
#: buried in this file. Nothing is excluded on this board.
UNSCORED_REASON = (
    "every metric is scoreable on this board: pol_1 judges goods, pol_2 judges the "
    "certificates themselves, and e_7 propagates the goods verdict up to the invoice"
)
