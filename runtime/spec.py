"""A read-only view over a frozen spec.

Everything the runtime needs to know about a process arrives through this
object. It exposes what freeze already resolved -- topo order, loop scopes,
verdict targets, joins -- and refuses to re-derive any of it: a node that looks
misordered here is a freeze bug, not something to work around at run time.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class Spec:
    def __init__(self, data: dict[str, Any]) -> None:
        self.data = data
        self.nodes: dict[str, dict[str, Any]] = {n["id"]: n for n in data.get("nodes", [])}
        self.edges: dict[str, dict[str, Any]] = {e["id"]: e for e in data.get("edges", [])}
        self.compiled: dict[str, Any] = data.get("compiled", {})

    @staticmethod
    def load(path: str | Path) -> "Spec":
        return Spec(json.loads(Path(path).read_text()))

    # ── identity ─────────────────────────────────────────────────────────
    @property
    def process_id(self) -> str:
        return self.data["process_id"]

    @property
    def spec_hash(self) -> str:
        return self.data["spec_hash"]

    # ── nodes ────────────────────────────────────────────────────────────
    def node(self, node_id: str) -> dict[str, Any]:
        return self.nodes[node_id]

    def config(self, node_id: str) -> dict[str, Any]:
        return self.nodes[node_id].get("config", {})

    def label(self, node_id: str) -> str:
        return self.nodes[node_id].get("label", node_id)

    def primitive(self, node_id: str) -> str:
        return self.nodes[node_id]["primitive"]

    def of_primitive(self, primitive: str) -> list[str]:
        return [i for i, n in self.nodes.items() if n["primitive"] == primitive]

    # ── compiled ─────────────────────────────────────────────────────────
    @property
    def topo_order(self) -> list[str]:
        return self.compiled.get("topo_order", [])

    @property
    def edge_roles(self) -> dict[str, str]:
        return self.compiled.get("edge_roles", {})

    @property
    def loop_scopes(self) -> dict[str, list[str]]:
        return self.compiled.get("loop_scopes", {})

    @property
    def verdict_targets(self) -> dict[str, str]:
        return self.compiled.get("verdict_targets", {})

    @property
    def identity_merges(self) -> dict[str, str]:
        return self.compiled.get("identity_merges", {})

    @property
    def joins(self) -> list[dict[str, Any]]:
        return self.compiled.get("joins", [])

    @property
    def fail_handlers(self) -> list[dict[str, Any]]:
        return self.compiled.get("fail_handlers", [])

    def parent_of(self, node_id: str) -> str | None:
        """The node this one's records hang off, per the contain/derive edges."""
        for edge_id, role in self.edge_roles.items():
            edge = self.edges.get(edge_id, {})
            if edge.get("to") == node_id and role in ("contain", "derive"):
                return edge.get("from")
        return None

    def reads_of(self, policy_id: str) -> list[str]:
        return list(self.config(policy_id).get("reads", []))

    def impl_bodies(self) -> list[str]:
        """Every `impl.body` in the spec -- what verify_generated compares against."""
        out = []
        for node in self.nodes.values():
            impl = node.get("config", {}).get("impl")
            if isinstance(impl, dict) and impl.get("body"):
                out.append(impl["body"])
        return out
