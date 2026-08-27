// Graph queries shared by the conditions, the option sources, and elaborate().
// Everything here is topology — no key is read for its meaning.

import type { Board, Edge, EdgeId, Node, NodeId, Primitive } from "./types.js";

export class Graph {
  readonly nodes: Node[];
  readonly edges: Edge[];
  private byId = new Map<NodeId, Node>();
  private outByNode = new Map<NodeId, Edge[]>();
  private inByNode = new Map<NodeId, Edge[]>();

  constructor(board: Board) {
    this.nodes = board.nodes;
    this.edges = board.edges;
    for (const n of board.nodes) this.byId.set(n.id, n);
    for (const e of board.edges) {
      if (!this.outByNode.has(e.from)) this.outByNode.set(e.from, []);
      if (!this.inByNode.has(e.to)) this.inByNode.set(e.to, []);
      this.outByNode.get(e.from)!.push(e);
      this.inByNode.get(e.to)!.push(e);
    }
  }

  node(id: NodeId): Node | undefined {
    return this.byId.get(id);
  }

  outgoing(id: NodeId): Edge[] {
    return this.outByNode.get(id) ?? [];
  }

  incoming(id: NodeId): Edge[] {
    return this.inByNode.get(id) ?? [];
  }

  primitiveOf(id: NodeId): Primitive | undefined {
    return this.byId.get(id)?.primitive;
  }

  /** Nodes of a given primitive with an edge INTO `id`. */
  inboundOf(id: NodeId, primitive: Primitive): Node[] {
    return this.incoming(id)
      .map((e) => this.byId.get(e.from))
      .filter((n): n is Node => !!n && n.primitive === primitive);
  }

  inboundArtifacts(id: NodeId): Node[] {
    return this.inboundOf(id, "artifact");
  }

  inboundChannels(id: NodeId): Node[] {
    return this.inboundOf(id, "channel");
  }

  /** Nodes of a given primitive that `id` points at. */
  outboundOf(id: NodeId, primitive: Primitive): Node[] {
    return this.outgoing(id)
      .map((e) => this.byId.get(e.to))
      .filter((n): n is Node => !!n && n.primitive === primitive);
  }

  byPrimitive(primitive: Primitive): Node[] {
    return this.nodes.filter((n) => n.primitive === primitive);
  }

  /**
   * A fail edge is policy -> channel. It makes the graph cyclic, so it is
   * stripped for ordering and cycle detection — but NOT for reachability,
   * because an outbound channel is only ever reachable through one.
   */
  isFailEdge(e: Edge): boolean {
    return this.primitiveOf(e.from) === "policy" && this.primitiveOf(e.to) === "channel";
  }

  dataEdges(): Edge[] {
    return this.edges.filter((e) => !this.isFailEdge(e));
  }

  failEdges(): Edge[] {
    return this.edges.filter((e) => this.isFailEdge(e));
  }

  /** Channels with no inbound edge are where data enters the process. */
  sourceChannels(): Node[] {
    return this.byPrimitive("channel").filter((n) => this.incoming(n.id).length === 0);
  }

  /** Channels that something points at — a send target. */
  isOutboundChannel(id: NodeId): boolean {
    return this.primitiveOf(id) === "channel" && this.incoming(id).length > 0;
  }
}

/** Fields declared on an artifact node. */
export function fieldsOf(n: Node | undefined): string[] {
  const f = n?.config?.fields;
  return Array.isArray(f) ? (f as string[]) : [];
}

/** "rec_batch.batch_number" -> { node: "rec_batch", field: "batch_number" } */
export function splitPath(path: string): { node: NodeId; field: string | null } {
  const i = path.indexOf(".");
  if (i === -1) return { node: path, field: null };
  return { node: path.slice(0, i), field: path.slice(i + 1) };
}

export function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function intersect(lists: string[][]): string[] {
  if (lists.length === 0) return [];
  return lists.reduce((acc, l) => acc.filter((x) => l.includes(x)));
}

/**
 * Kahn's algorithm over a supplied edge set. Returns null when a cycle exists,
 * so the caller can distinguish "no order" from "empty graph".
 */
export function topoSort(nodes: Node[], edges: Edge[]): NodeId[] | null {
  const indeg = new Map<NodeId, number>();
  const out = new Map<NodeId, NodeId[]>();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    out.set(n.id, []);
  }
  for (const e of edges) {
    if (!indeg.has(e.to) || !out.has(e.from)) continue;
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    out.get(e.from)!.push(e.to);
  }
  // Sorted seed + sorted insertion keeps the order deterministic, which matters
  // because topo_order lands in the spec and the spec gets hashed.
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order: NodeId[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of (out.get(id) ?? []).sort()) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }
  return order.length === nodes.length ? order : null;
}

/** Node ids reachable from `starts` over `edges`. */
export function reachableFrom(starts: NodeId[], edges: Edge[]): Set<NodeId> {
  const out = new Map<NodeId, NodeId[]>();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e.to);
  }
  const seen = new Set<NodeId>(starts);
  const stack = [...starts];
  while (stack.length) {
    const id = stack.pop()!;
    for (const next of out.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/** Node ids that can reach any of `targets` over `edges`. */
export function reachesAny(targets: NodeId[], edges: Edge[]): Set<NodeId> {
  const reversed = edges.map((e) => ({ ...e, from: e.to, to: e.from }));
  return reachableFrom(targets, reversed);
}

/**
 * The `many` edges enclosing each node, as edge ids in path order. Codegen needs
 * the edge, not the parent node: two `many` edges from one parent are only
 * distinguishable by edge, and each needs its own iterator variable.
 */
export function loopScopes(g: Graph, order: NodeId[]): Record<NodeId, EdgeId[]> {
  const scopes: Record<NodeId, EdgeId[]> = {};
  for (const id of order) {
    // An Output aggregates ACROSS the loop rather than running inside it:
    // `count` of a record counts every one, it does not run once per record.
    // So outputs sit outside every scope, and inherit none.
    if (g.primitiveOf(id) === "output") continue;

    const inbound = g.incoming(id).filter((e) => !g.isFailEdge(e));
    let best: EdgeId[] = [];
    for (const e of inbound) {
      const parent = scopes[e.from] ?? [];
      const here = e.config?.cardinality === "many" ? [...parent, e.id] : parent;
      if (here.length > best.length) best = here;
    }
    if (best.length) scopes[id] = best;
  }
  return scopes;
}
