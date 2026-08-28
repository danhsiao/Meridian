"""Transports and extraction, still with no domain in sight."""
import json

import pytest

from runtime.channels import registry
from runtime.channels.base import Channel, Sent
from runtime.channels.capture import CaptureChannel
from runtime.channels.composio import _query, part_text
from runtime.channels.replay import ReplayChannel
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
