"""Transports and extraction, still with no domain in sight."""
import json

import pytest

from runtime.channels import registry
from runtime.channels.base import Channel, Sent
from runtime.channels.capture import CaptureChannel
from runtime.channels.composio import _query, part_text
from runtime.channels.replay import ReplayChannel
from runtime.channels import verbs
from runtime.spec import Spec
from runtime.extract import build_prompt, extract
from runtime.payload import Part, Payload


class FakeChannel:
    tool = "fake"

    def __init__(self):
        self.sent = []

    def fetch(self, match=None, limit=25):
        return [Payload(id="m1", text=str(match))]

    def send(self, request):
        self.sent.append(request)
        return Sent(tool="fake", request=request, delivered=True)


def test_the_dispatch_table_resolves_by_tool_string():
    assert set(registry.known()) == {"composio.gmail", "composio.slack", "http.get"}
    assert registry.resolve("composio.gmail").tool == "composio.gmail"


def test_two_providers_behind_one_integration_layer_share_one_adapter_class():
    """Adding a provider under an integration layer is a row, not a file."""
    a = registry.resolve("composio.gmail")
    b = registry.resolve("composio.slack")
    assert type(a) is type(b)
    assert a.slugs != b.slugs


def test_an_unknown_tool_says_where_to_add_it():
    with pytest.raises(KeyError, match="registry.py"):
        registry.resolve("carrier.pigeon")


def test_the_fake_satisfies_the_protocol():
    assert isinstance(FakeChannel(), Channel)


def test_capture_records_a_send_to_disk_instead_of_delivering_it(tmp_path):
    inner = FakeChannel()
    channel = CaptureChannel(inner, tmp_path)
    result = channel.send({"to": "someone@example.com", "subject": "s", "body": "b"})
    assert result.delivered is False
    assert inner.sent == []  # nothing reached the adapter
    written = json.loads((tmp_path / "send-001.json").read_text())
    assert written["request"]["subject"] == "s"


def test_capture_leaves_fetch_alone():
    channel = CaptureChannel(FakeChannel(), "/tmp/unused")
    assert channel.fetch("q")[0].text == "q"


def test_replay_reads_snapshots_and_says_so_when_there_are_none(tmp_path):
    with pytest.raises(FileNotFoundError, match="cli fetch"):
        ReplayChannel(tmp_path / "missing").fetch()
    (tmp_path / "0001.json").write_text(
        json.dumps(Payload(id="m1", text="hello", parts=[Part(name="p")]).to_dict())
    )
    payloads = ReplayChannel(tmp_path).fetch()
    assert len(payloads) == 1 and payloads[0].text == "hello"


def test_a_replayed_send_is_never_delivered(tmp_path):
    assert ReplayChannel(tmp_path).send({"to": "x"}).delivered is False


def test_query_building_covers_the_shapes_a_prompt_key_can_hold():
    assert _query("subject:hello") == "subject:hello"
    assert _query(["one", "two"]) == "one two"
    assert _query({"subject_patterns": ["A", "B"]}) == 'subject:"A" OR subject:"B"'
    assert _query(None) == ""


def test_part_text_reads_what_it_can_and_returns_empty_for_what_it_cannot():
    assert part_text(b"plain", "text/plain") == "plain"
    assert part_text(b'{"a":1}', "application/json") == '{"a":1}'
    assert part_text(b"\x89PNG", "image/png") == ""
    assert part_text(b"not a pdf", "application/pdf").startswith("(unreadable")


# ── extraction ───────────────────────────────────────────────────────────
def test_the_prompt_is_assembled_only_from_spec_values_and_the_payload():
    payload = Payload(
        id="m1", text="body text",
        parts=[Part(name="one.pdf", mimetype="application/pdf", text="part text")],
    )
    prompt = build_prompt(
        label="Part", fields=["f1", "f2"], source_hint="the one headed 'Part'",
        extraction_hint=None, payload=payload,
    )
    for expected in ("Part", "f1", "f2", "the one headed 'Part'", "body text", "part text", "one.pdf"):
        assert expected in prompt


def test_an_artifact_with_no_fields_becomes_one_pass_through_record():
    """Freeze only allows a fieldless artifact when it holds child records, so
    the envelope is exactly one record and the children hang off it."""
    records = extract(Payload(id="m1", text="x"), node_id="a1", label="Item", fields=[])
    assert len(records) == 1
    assert records[0].fields == {} and records[0].source == "m1"


def test_extraction_drops_keys_the_model_invented(monkeypatch):
    monkeypatch.setattr(
        "runtime.extract.call_model",
        lambda prompt: [{"f1": "A", "f2": "B", "hallucinated": "nope"}],
    )
    records = extract(Payload(id="m1"), node_id="a2", label="Part", fields=["f1", "f2"])
    assert records[0].fields == {"f1": "A", "f2": "B"}


def test_a_missing_field_arrives_as_none_rather_than_absent(monkeypatch):
    monkeypatch.setattr("runtime.extract.call_model", lambda prompt: [{"f1": "A"}])
    records = extract(Payload(id="m1"), node_id="a2", label="Part", fields=["f1", "f2"])
    assert records[0].fields == {"f1": "A", "f2": None}


# ── the channel verbs generated code calls ───────────────────────────────────


def _spec_with_channel(tmp_path, config, node_id="c1"):
    path = tmp_path / "spec.json"
    path.write_text(
        json.dumps(
            {
                "process_id": "t",
                "spec_hash": "sha256:0",
                "nodes": [{"id": node_id, "primitive": "channel", "config": config}],
                "edges": [],
                "compiled": {"topo_order": [node_id]},
            }
        )
    )
    return Spec.load(path)


def test_given_payloads_short_circuit_the_fetch(tmp_path, monkeypatch):
    """The eval harness's override: hand payloads in, nothing is resolved."""
    spec = _spec_with_channel(tmp_path, {"tool": "composio.gmail", "match": "q"})
    monkeypatch.setattr(
        registry, "resolve", lambda tool: pytest.fail("resolved a transport despite `given`")
    )
    items = verbs.inbound(spec, "c1", given=[Payload(id="m1", text="hi").to_dict()])
    assert [p.id for p in items] == ["m1"]


def test_without_given_the_agent_fetches_through_the_registry(tmp_path, monkeypatch):
    spec = _spec_with_channel(tmp_path, {"tool": "composio.gmail", "match": "board prose"})
    monkeypatch.setattr(registry, "resolve", lambda tool: FakeChannel())
    assert verbs.inbound(spec, "c1")[0].text == "board prose"


def test_a_queries_sidecar_overrides_the_boards_prose_match(tmp_path, monkeypatch):
    """`match` is prose an operator wrote; a provider needs a query."""
    spec = _spec_with_channel(tmp_path, {"tool": "composio.gmail", "match": "board prose"})
    (tmp_path / "queries.json").write_text(json.dumps({"c1": "has:attachment"}))
    monkeypatch.setattr(registry, "resolve", lambda tool: FakeChannel())
    assert verbs.inbound(spec, "c1")[0].text == "has:attachment"
    assert spec.config("c1")["match"] == "board prose"  # the spec is untouched


def test_outbound_captures_unless_the_mode_is_live(tmp_path, monkeypatch):
    spec = _spec_with_channel(tmp_path, {"tool": "composio.gmail"})
    inner = FakeChannel()
    monkeypatch.setattr(registry, "resolve", lambda tool: inner)
    monkeypatch.setenv("CHANNEL_MODE", "capture")
    monkeypatch.setenv("CHANNEL_CAPTURE_DIR", str(tmp_path / "captured"))
    assert verbs.outbound(spec, "c1", [{"label": "row"}]).delivered is False
    assert inner.sent == []  # nothing reached the adapter

    monkeypatch.setenv("CHANNEL_MODE", "live")
    assert verbs.outbound(spec, "c1", [{"label": "row"}]).delivered is True
    assert inner.sent[0]["body"] == [{"label": "row"}]


def test_outbound_never_invents_a_recipient_the_board_did_not_give(tmp_path, monkeypatch):
    spec = _spec_with_channel(tmp_path, {"tool": "composio.gmail", "describes": "email daniel"})
    monkeypatch.setattr(registry, "resolve", lambda tool: FakeChannel())
    monkeypatch.setenv("CHANNEL_MODE", "capture")
    monkeypatch.setenv("CHANNEL_CAPTURE_DIR", str(tmp_path / "captured"))
    assert verbs.outbound(spec, "c1", []).request["recipient_email"] is None
