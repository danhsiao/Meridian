"""Turn a payload into records, using only what the spec says.

This is the only place in the engine where a model touches business data, and it
reads that data's shape out of the spec rather than knowing any of it: the
prompt is assembled from {label, fields, source_hint, extraction_hint} and the
payload, and nothing else. Swap the spec and the same function extracts from a
different domain with no code change -- which is the property the noun lint
exists to keep true.

Results are cached on disk by content hash. Extraction is the slowest and least
deterministic step in a run, and a heal loop that re-extracts on every iteration
cannot tell whether a fixture flipped because a patch worked or because the
model wobbled.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

from . import env
from .payload import Payload, Record, record_id_for

PART_CHAR_LIMIT = 30_000
CACHE_DIR = Path(env.get("EXTRACT_CACHE_DIR") or ".cache/extract")

_client = None


def _anthropic():
    global _client
    if _client is None:
        import anthropic

        keys = env.require("ANTHROPIC_API_KEY")
        _client = anthropic.Anthropic(api_key=keys["ANTHROPIC_API_KEY"])
    return _client


def _model() -> str:
    return env.get("ANTHROPIC_MODEL") or "claude-sonnet-5"


def _source_text(payload: Payload) -> str:
    chunks = []
    if payload.text.strip():
        chunks.append(f"--- message body ---\n{payload.text[:PART_CHAR_LIMIT]}")
    for part in payload.parts:
        chunks.append(f"--- part: {part.name} ({part.mimetype}) ---\n{part.text[:PART_CHAR_LIMIT]}")
    return "\n\n".join(chunks) if chunks else "(empty)"


def build_prompt(
    *,
    label: str,
    fields: list[str],
    source_hint: str | None,
    extraction_hint: str | None,
    payload: Payload,
) -> str:
    lines = [
        "You are extracting structured records from one incoming item.",
        "",
        f'The records you are looking for are called: "{label}".',
    ]
    if source_hint:
        lines += ["", f"Where to find them: {source_hint}"]
    if extraction_hint:
        lines += ["", f"Additional guidance: {extraction_hint}"]
    lines += [
        "",
        "Pull exactly these values for each one. Use these names verbatim as JSON keys:",
        *[f"  - {f}" for f in fields],
        "",
        "Rules:",
        '  - Reply with JSON only: {"records": [{...}, ...]}. No prose, no code fences.',
        "  - One object per record you find. Return an empty list if there are none.",
        "  - Copy values exactly as written in the source. Do not reformat, pad, or tidy them.",
        "  - If a value is genuinely not stated for a record, use null. Never invent one.",
        "  - Do not add keys that are not on the list above.",
        "",
        "=== the incoming item ===",
        _source_text(payload),
    ]
    return "\n".join(lines)


def _cache_path(prompt: str) -> Path:
    digest = hashlib.sha256(f"{_model()}\n{prompt}".encode()).hexdigest()
    return CACHE_DIR / f"{digest}.json"


def _parse(text: str) -> list[dict[str, Any]]:
    text = text.strip()
    fenced = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.S)
    if fenced:
        text = fenced.group(1)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end == -1:
            return []
        try:
            data = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return []
    if isinstance(data, list):
        return [d for d in data if isinstance(d, dict)]
    rows = data.get("records", []) if isinstance(data, dict) else []
    return [r for r in rows if isinstance(r, dict)]


def call_model(prompt: str) -> list[dict[str, Any]]:
    """Cached model call. The cache is keyed on model + prompt, so pinning
    ANTHROPIC_MODEL is what makes an eval score reproducible."""
    path = _cache_path(prompt)
    if path.exists():
        return json.loads(path.read_text())
    if os.environ.get("EXTRACT_OFFLINE"):
        raise RuntimeError(
            "EXTRACT_OFFLINE is set and this prompt is not cached. "
            "Run `cli fetch` and one non-offline eval first."
        )
    response = _anthropic().messages.create(
        model=_model(),
        max_tokens=8000,
        messages=[{"role": "user", "content": prompt}],
    )
    rows = _parse("".join(b.text for b in response.content if b.type == "text"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, indent=2))
    return rows


def extract(
    payload: Payload,
    *,
    node_id: str,
    label: str,
    fields: list[str] | None = None,
    source_hint: str | None = None,
    extraction_hint: str | None = None,
    parent_id: str | None = None,
) -> list[Record]:
    """Payload -> records for one artifact node.

    An artifact with no `fields` declares no values of its own: freeze only lets
    that through when the node holds child records, so it becomes exactly one
    pass-through record and the children hang off it.
    """
    fields = list(fields or [])
    if not fields:
        return [
            Record(
                node_id=node_id,
                record_id=record_id_for(node_id, {"payload": payload.id}, parent_id, 0),
                fields={},
                source=payload.id,
                parent_id=parent_id,
            )
        ]

    prompt = build_prompt(
        label=label,
        fields=fields,
        source_hint=source_hint,
        extraction_hint=extraction_hint,
        payload=payload,
    )
    records = []
    for ordinal, row in enumerate(call_model(prompt)):
        # The declared field list is the contract. A key the model invented is
        # dropped rather than carried, so a hallucinated column can never reach
        # a relation.
        values = {f: row.get(f) for f in fields}
        records.append(
            Record(
                node_id=node_id,
                record_id=record_id_for(node_id, values, parent_id, ordinal),
                fields=values,
                source=payload.id,
                parent_id=parent_id,
            )
        )
    return records


def scope_hint(parent_label: str, parent_fields: dict[str, Any]) -> str:
    """Narrow an extraction to the records belonging to one parent.

    A nested artifact -- rows inside one of several documents in the same
    payload -- has to say *which* parent it belongs to, or the model returns
    every row in the payload for every parent. The sentence is assembled from
    the parent's label and its own extracted values, both of which come from the
    spec and the run, so codegen emits one call and knows no domain.
    """
    stated = ", ".join(f"{k} = {v!r}" for k, v in parent_fields.items() if v not in (None, ""))
    if not stated:
        return f"Only the ones belonging to this {parent_label}."
    return (
        f"Only the ones belonging to the {parent_label} where {stated}. "
        f"Ignore any that belong to a different {parent_label}."
    )
