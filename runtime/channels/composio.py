"""One adapter, parameterised by action slug.

There is deliberately not one module per provider. Composio *is* a dispatch
layer -- two providers under it differ by action slug and payload shape, not by
transport mechanics -- so a second provider is a row in the registry, not a
file. Separate modules belong at a real provider boundary, where authentication
and retry genuinely differ.
"""
from __future__ import annotations

import io
from typing import Any

import httpx

from .. import env
from ..payload import Part, Payload
from .base import Sent

TEXT_MIMETYPES = ("text/", "application/json", "application/xml")


def _pdf_text(raw: bytes) -> str:
    try:
        from pypdf import PdfReader

        return "\n".join((page.extract_text() or "") for page in PdfReader(io.BytesIO(raw)).pages)
    except Exception as exc:  # a part we cannot read is a part, not a crash
        return f"(unreadable: {exc})"


def part_text(raw: bytes, mimetype: str) -> str:
    if mimetype == "application/pdf":
        return _pdf_text(raw)
    if any(mimetype.startswith(prefix) for prefix in TEXT_MIMETYPES):
        return raw.decode("utf-8", errors="replace")
    return ""


class ComposioChannel:
    """A channel backed by a Composio toolkit.

    `slugs` names the actions this row uses. The registry supplies them; nothing
    here knows which provider is on the other end.
    """

    def __init__(self, tool: str, slugs: dict[str, str]) -> None:
        self.tool = tool
        self.slugs = slugs
        self._client = None
        self._user_id: str | None = None

    # ── plumbing ─────────────────────────────────────────────────────────
    def _connect(self):
        if self._client is None:
            from composio import Composio

            keys = env.require("COMPOSIO_API_KEY", "COMPOSIO_USER_ID")
            self._client = Composio(api_key=keys["COMPOSIO_API_KEY"])
            self._user_id = keys["COMPOSIO_USER_ID"]
        return self._client

    def _execute(self, slug: str, arguments: dict[str, Any]) -> dict[str, Any]:
        client = self._connect()
        result = client.tools.execute(
            slug,
            user_id=self._user_id,
            arguments=arguments,
            # The toolkit pins its own version server-side; the SDK asks callers
            # to opt out of the check explicitly rather than defaulting to it.
            dangerously_skip_version_check=True,
        )
        if not result.get("successful"):
            raise RuntimeError(f"{slug} failed: {result.get('error')}")
        return result.get("data") or {}

    # ── the protocol ─────────────────────────────────────────────────────
    def fetch(self, match: Any = None, limit: int = 25) -> list[Payload]:
        data = self._execute(
            self.slugs["fetch"], {"query": _query(match), "max_results": limit}
        )
        return [self._to_payload(item) for item in data.get("messages", [])]

    def send(self, request: dict[str, Any]) -> Sent:
        data = self._execute(self.slugs["send"], dict(request))
        return Sent(tool=self.tool, request=dict(request), delivered=True, detail=data)

    # ── shaping ──────────────────────────────────────────────────────────
    def _to_payload(self, item: dict[str, Any]) -> Payload:
        parts = []
        for attachment in item.get("attachmentList") or []:
            raw = self._download(item, attachment)
            parts.append(
                Part(
                    name=attachment.get("filename", ""),
                    mimetype=attachment.get("mimeType", "application/octet-stream"),
                    text=part_text(raw, attachment.get("mimeType", "")),
                )
            )
        return Payload(
            id=item.get("messageId") or item.get("id") or "",
            meta={
                k: item.get(k)
                for k in ("subject", "sender", "to", "threadId", "messageTimestamp", "labelIds")
                if item.get(k) is not None
            },
            text=item.get("messageText") or "",
            parts=parts,
        )

    def _download(self, item: dict[str, Any], attachment: dict[str, Any]) -> bytes:
        data = self._execute(
            self.slugs["attachment"],
            {
                "message_id": item.get("messageId"),
                "attachment_id": attachment.get("attachmentId"),
                "file_name": attachment.get("filename"),
            },
        )
        url = ((data.get("file") or {}).get("s3url")) or ""
        if not url:
            return b""
        return httpx.get(url, timeout=120).content


def _query(match: Any) -> str:
    """Spec `match` -> provider query string.

    `match` is a `prompt`-bound key, so it is whatever the operator wrote. A dict
    is a structured filter; a list is several lines of one answer; a string is
    used as written.
    """
    if match is None:
        return ""
    if isinstance(match, str):
        return match
    if isinstance(match, list):
        return " ".join(str(m) for m in match)
    if isinstance(match, dict):
        terms = []
        for key, value in match.items():
            values = value if isinstance(value, list) else [value]
            for v in values:
                terms.append(f'{key.rstrip("s").replace("_pattern", "")}:"{v}"')
        return " OR ".join(terms)
    return str(match)
