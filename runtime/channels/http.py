"""A plain HTTP transport.

Its own module rather than another Composio slug, because this is a real
provider boundary: no integration layer holds the credential, retry is ours, and
the response shape is whatever the far end returns.
"""
from __future__ import annotations

from typing import Any

import httpx

from ..payload import Part, Payload
from .base import Sent


class HttpChannel:
    def __init__(self, tool: str) -> None:
        self.tool = tool

    def fetch(self, match: Any = None, limit: int = 25) -> list[Payload]:
        url = match if isinstance(match, str) else (match or {}).get("url", "")
        if not url:
            raise ValueError("http.get needs a url in the channel's `match`")
        response = httpx.get(url, timeout=60)
        response.raise_for_status()
        return [
            Payload(
                id=url,
                meta={"status": response.status_code, "url": url},
                text=response.text,
                parts=[Part(name="body", mimetype=response.headers.get("content-type", "text/plain"), text=response.text)],
            )
        ]

    def send(self, request: dict[str, Any]) -> Sent:
        url = request.get("url", "")
        response = httpx.post(url, json=request.get("json"), data=request.get("body"), timeout=60)
        return Sent(
            tool=self.tool,
            request=dict(request),
            delivered=True,
            detail={"status": response.status_code},
        )
