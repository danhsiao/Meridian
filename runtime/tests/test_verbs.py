"""The runtime, exercised against a spec with no domain in it.

Written and made green before any real process existed. An API whose first
caller has no domain cannot be shaped around one -- which is the whole reason
these tests use `a1`/`p1`/`f1` and never a noun.
"""
from pathlib import Path

import pytest

from runtime import guards, outputs, relations
from runtime.helpers import days_between, is_blank, normalize, squash, to_number
from runtime.identity import merge_by_identity_key
from runtime.payload import Payload, Part, Record, record_id_for
from runtime.spec import Spec
from runtime.state import RunState, split_path

SPEC_PATH = Path(__file__).parent / "synthetic_spec.json"


def record(node_id, fields, parent_id=None, ordinal=0):
    return Record(
        node_id=node_id,
        record_id=record_id_for(node_id, fields, parent_id, ordinal),
        fields=fields,
        parent_id=parent_id,
    )


# ── relations ────────────────────────────────────────────────────────────
def test_present_wants_every_value():
    assert relations.present(["x", "y"])
    assert not relations.present(["x", ""])
    assert not relations.present(["x", None])
    assert not relations.present(["x", "   "])


def test_equals_is_numeric_when_both_sides_are():
    assert relations.equals("1,200.00", "1200")
    assert relations.equals("abc", " abc ")
    assert not relations.equals("abc", "abd")


def test_greater_than_declines_on_unparseable_input():
    assert relations.greater_than("10", "2")
    assert not relations.greater_than("2", "10")
    assert not relations.greater_than("banana", "2")


def test_exists_matching_takes_its_comparison_as_data():
    assert relations.exists_matching("A1", ["Z9", "A1"])
    assert not relations.exists_matching("A1", ["Z9"])
    # The formatting-tolerant comparison is passed in, not baked in -- which is
    # what lets a generated agent be patched without touching the engine.
    assert not relations.exists_matching("A 1 ", ["A1"])
    assert relations.exists_matching("A 1 ", ["A1"], key=squash)


def test_exists_matching_never_matches_on_emptiness():
    assert not relations.exists_matching("", ["", "x"])
    assert not relations.exists_matching("x", ["", None])


def test_every_registry_relation_has_a_function():
    assert set(relations.RELATIONS) == {"present", "equals", "greater_than", "exists_matching"}


# ── guards ───────────────────────────────────────────────────────────────
def test_guard_decides_only_when_something_is_empty():
    assert guards.on_absent(["a", "b"], "fail") is None
    assert guards.on_absent(["a", ""], "fail") is False
    assert guards.on_absent(["a", ""], "pass") is True


def test_guard_stands_down_for_relations_that_are_about_emptiness():
    assert guards.subsumes_guard("present")
    assert not guards.subsumes_guard("exists_matching")


def test_guard_rejects_a_policy_value_outside_the_enum():
    with pytest.raises(ValueError):
        guards.on_absent(["a"], "maybe")


# ── helpers ──────────────────────────────────────────────────────────────
def test_helpers():
    assert normalize("  A  B ") == "a b"
    assert squash("AALC 25063A ") == squash("aalc25063a")
    assert is_blank(None) and is_blank("  ") and not is_blank(0)
    assert days_between("2026-01-01", "2026-01-31") == 30
    assert days_between("31-JUL-26", "2026-08-10") == 10
    assert to_number("USD 1,200.50") == 1200.50
    assert to_number("n/a") is None


# ── state ────────────────────────────────────────────────────────────────
def test_split_path_splits_on_the_first_dot_only():
    assert split_path("a2.f1") == ("a2", "f1")
    assert split_path("a2.some field.with a dot") == ("a2", "some field.with a dot")


def test_a_failing_verdict_is_never_overwritten_by_a_later_pass():
    state = RunState()
    r = state.add("a4", [record("a4", {"f3": "x", "f4": ""})])[0]
    state.verdict("p1", "a4", r, False, "f4 empty")
    state.verdict("p9", "a4", r, True)
    assert state.verdict_of("a4", r).ok is False
    assert state.failed("a4") == [r]


def test_children_are_scoped_to_their_parent():
    state = RunState()
    parent_a = state.add("a2", [record("a2", {"f1": "A"}, ordinal=0)])[0]
    parent_b = state.add("a2", [record("a2", {"f1": "B"}, ordinal=1)])[0]
    state.add("a4", [record("a4", {"f3": "1"}, parent_id=parent_a.record_id)])
    state.add("a4", [record("a4", {"f3": "2"}, parent_id=parent_b.record_id)])
    assert [r.get("f3") for r in state.children("a4", parent_a)] == ["1"]
    assert [r.get("f3") for r in state.children("a4", parent_b)] == ["2"]


def test_select_filters_on_verdict():
    state = RunState()
    good = state.add("a2", [record("a2", {"f1": "A"}, ordinal=0)])[0]
    bad = state.add("a2", [record("a2", {"f1": "B"}, ordinal=1)])[0]
    state.verdict("p2", "a2", good, True)
    state.verdict("p2", "a2", bad, False)
    assert state.select("a2", None) == [good, bad]
    assert state.select("a2", "pass") == [good]
    assert state.select("a2", "fail") == [bad]


# ── identity ─────────────────────────────────────────────────────────────
def test_merge_is_last_write_wins_on_collision_and_union_on_absence():
    rows = [
        record("a2", {"f1": "K", "f2": "first"}, ordinal=0),
        record("a2", {"f1": "K", "f2": "second"}, ordinal=1),
        record("a2", {"f1": "K", "f2": None}, ordinal=2),
    ]
    merged = merge_by_identity_key(rows, "f1")
    assert len(merged) == 1
    assert merged[0].get("f2") == "second"


def test_merge_keeps_keyless_records_distinct():
    rows = [record("a2", {"f1": None}, ordinal=0), record("a2", {"f1": None}, ordinal=1)]
    assert len(merge_by_identity_key(rows, "f1")) == 2


# ── outputs ──────────────────────────────────────────────────────────────
def test_output_rows_honour_where():
    state = RunState()
    good = state.add("a2", [record("a2", {"f1": "A"}, ordinal=0)])[0]
    bad = state.add("a2", [record("a2", {"f1": "B"}, ordinal=1)])[0]
    line = state.add("a4", [record("a4", {"f3": "1", "f4": ""})])[0]
    state.verdict("p2", "a2", good, True)
    state.verdict("p2", "a2", bad, False)
    state.verdict("p1", "a4", line, False)

    spec = Spec.load(SPEC_PATH)
    result = outputs.rows(state, spec.config("o1")["rows"])
    assert result == {
        "parts_total": 2,
        "parts_failed": 1,
        "lines_failed": 1,
        "failed_f1": ["B"],
    }


def test_every_registry_output_fn_has_a_function():
    assert set(outputs.FUNCTIONS) == {"count", "sum", "list", "copy", "verdict"}


# ── spec ─────────────────────────────────────────────────────────────────
def test_spec_exposes_what_freeze_resolved_and_derives_none_of_it():
    spec = Spec.load(SPEC_PATH)
    assert spec.topo_order == ["c1", "a1", "a2", "a3", "a4", "p1", "p2", "o1"]
    assert spec.verdict_targets == {"p1": "a4", "p2": "a2"}
    assert spec.loop_scopes["a4"] == ["e2", "e4"]
    assert spec.parent_of("a4") == "a2"
    assert spec.parent_of("c1") is None
    assert spec.reads_of("p2") == ["a2.f1", "a3.f1"]


def test_payload_round_trips_through_disk_shape():
    payload = Payload(
        id="m1", meta={"subject": "s"}, text="body",
        parts=[Part(name="p.pdf", mimetype="application/pdf", text="text")],
    )
    assert Payload.from_dict(payload.to_dict()) == payload


def test_record_ids_are_content_addressed():
    a = record_id_for("a2", {"f1": "X"}, None, 0)
    b = record_id_for("a2", {"f1": "X"}, None, 0)
    c = record_id_for("a2", {"f1": "Y"}, None, 0)
    assert a == b and a != c
