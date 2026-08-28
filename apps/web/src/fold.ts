// The canvas draws what's surprising and folds what's obvious.
//
// Nine nodes render as four cards. All nine are in the spec regardless — this
// is a VIEW concern and nothing here may change what freezes. The compiler
// enforces that separately: every node in the store appears in the frozen spec.
//
//   Containment edge          -> indented row inside the parent card
//   Policy reading 1 artifact -> a row inside that card, counted in a badge
//   Policy reading 2+         -> its own box, because it belongs to neither
//   Join edge                 -> a line with the key on it
//   Merge                     -> drawn; neither parent can host the other
//   Fail edge                 -> a red line to the outbound channel

// The client subpath, not the barrel: this runs in the browser, and the barrel
// re-exports freeze(), which hashes with node:crypto.
import { Graph, policyIsResolved } from "@engine/compiler/client";
import type { Board, Edge, Node, NodeId } from "@engine/compiler/client";

export interface FieldRow {
  kind: "field";
  name: string;
}

/** A contained artifact, folded into its parent as an indented row. */
export interface ChildRow {
  kind: "child";
  node: Node;
  depth: number;
  fields: FieldRow[];
  /** Checks that read only this child, folded in alongside it. */
  checks: Node[];
}

/** A policy reading exactly this artifact, folded in as a row. */
export interface CheckRow {
  kind: "check";
  node: Node;
}

export type Row = FieldRow | ChildRow | CheckRow;

export interface Card {
  node: Node;
  rows: Row[];
  /** How many checks are folded into this card, at any depth. */
  checkCount: number;
  /** Every node this card stands for, including folded ones. Used for pins. */
  covers: NodeId[];
}

export type DrawnEdgeKind =
  | "derive" | "join" | "merge" | "read" | "outcome" | "value" | "input" | "fail"
  /** The finished report going out. Once, at the end of the run. */
  | "report"
  /** Two records, relationship not decided yet. Drawn, and asking. */
  | "undecided"
  /**
   * A connection the compiler has no role for — an output back into a channel,
   * a policy into a policy. `elaborate()` calls it `edge_not_expressible` and
   * blocks freeze on it, so the canvas must SHOW it: an edge that exists in the
   * store and not on screen is the worst of both, because drawing it again
   * gets refused as a duplicate and there is nothing on the board to delete.
   */
  | "invalid";

export interface DrawnEdge {
  edge: Edge;
  kind: DrawnEdgeKind;
  /** From/to resolved to the CARD that stands for the node, not the node. */
  fromCard: NodeId;
  toCard: NodeId;
  /** Join edges carry the key on the line. */
  label?: string;
}

export interface Folded {
  cards: Card[];
  edges: DrawnEdge[];
  /** node id -> the card it is drawn on. Every node maps to exactly one. */
  cardOf: Record<NodeId, NodeId>;
}

export function fold(board: Board): Folded {
  const g = new Graph(board);

  const parentOf = new Map<NodeId, NodeId>();
  for (const e of board.edges) {
    if (isContainment(g, e)) parentOf.set(e.to, e.from);
  }

  // A policy reading exactly one artifact belongs to that artifact. A policy
  // reading two belongs to neither, so it keeps its own box.
  const hostOf = new Map<NodeId, NodeId>();
  for (const p of g.byPrimitive("policy")) {
    const reads = g.inboundArtifacts(p.id);
    // Fold only what is FINISHED. A check still being defined has to stay a
    // card of its own: folded, it can't be selected, can't be edited, and a
    // second record can't be pointed at it — which is the whole reason a
    // check would ever read two things.
    //
    // "Finished" is structural. A `check` holding a sentence rather than a
    // resolved relation is a check still being defined, and folding it away is
    // precisely when she can least afford to lose the card: a cross-reference
    // needs a second edge drawn to it, and there is nothing left to drag to.
    if (reads.length === 1 && policyIsResolved(p)) hostOf.set(p.id, reads[0].id);
  }

  const isFolded = (id: NodeId) => parentOf.has(id) || hostOf.has(id);

  const cards: Card[] = [];
  const cardOf: Record<NodeId, NodeId> = {};

  for (const n of board.nodes) {
    if (isFolded(n.id)) continue;
    const rows: Row[] = fieldsOf(n).map((name) => ({ kind: "field", name }) as FieldRow);
    const covers: NodeId[] = [n.id];

    for (const check of checksHostedBy(n.id, hostOf, board)) {
      rows.push({ kind: "check", node: check });
      covers.push(check.id);
    }
    for (const child of childRows(n.id, parentOf, hostOf, board, 1, covers)) {
      rows.push(child);
    }

    const card: Card = { node: n, rows, checkCount: countChecks(rows), covers };
    cards.push(card);
    for (const id of covers) cardOf[id] = n.id;
  }

  const drawn: DrawnEdge[] = [];
  for (const e of board.edges) {
    // Folded away: the containment IS the indentation, and a single-read edge
    // IS the row. Drawing them too would say the same thing twice.
    if (isContainment(g, e)) continue;
    if (hostOf.get(e.to) === e.from) continue;

    const kind = drawnKind(g, e);
    if (!kind) continue;

    const fromCard = cardOf[e.from];
    const toCard = cardOf[e.to];
    // Both endpoints resolve, or the edge has nowhere to land. Can only happen
    // if a node was folded into a card that itself got folded, which the
    // parent/host rules prevent — but bail rather than draw a ghost.
    if (!fromCard || !toCard || fromCard === toCard) continue;

    drawn.push({
      edge: e,
      kind,
      fromCard,
      toCard,
      label:
        kind === "join" ? (e.config.on as string | undefined)
        : kind === "undecided" ? "how do these relate?"
        // Names the problem on the line itself. The blocking finding sits on
        // this edge, and a red line with no explanation is just as puzzling as
        // no line at all.
        : kind === "invalid" ? "this can't connect — delete it"
        : undefined,
    });
  }

  return { cards, edges: drawn, cardOf };
}

// ── helpers ─────────────────────────────────────────────────────────────

function isContainment(g: Graph, e: Edge): boolean {
  return (
    g.primitiveOf(e.from) === "artifact" &&
    g.primitiveOf(e.to) === "artifact" &&
    e.config.rel === "contains"
  );
}

/**
 * The one case that returns null is containment, and only because the
 * indentation IS the edge. Everything else she drew gets drawn — including
 * combinations the compiler cannot express. An undrawn edge is worse than an
 * undecided one, and worse still than an invalid one: it is in the store,
 * blocking freeze, invisible, and un-redrawable.
 */
function drawnKind(g: Graph, e: Edge): DrawnEdgeKind | null {
  const from = g.primitiveOf(e.from);
  const to = g.primitiveOf(e.to);
  // An endpoint that isn't on the board is a broken row, not a drawable edge.
  if (!from || !to) return null;
  if (from === "channel" && to === "artifact") return "derive";
  if (from === "artifact" && to === "policy") return "read";
  if (from === "artifact" && to === "channel") return "input";
  if (from === "policy" && to === "output") return "outcome";
  if (from === "artifact" && to === "output") return "value";
  if (from === "policy" && to === "channel") return "fail";
  if (from === "output" && to === "channel") return "report";
  if (from === "artifact" && to === "artifact") {
    if (e.config.rel === "pairs_with") return "join";
    if (e.config.rel === "builds_from") return "merge";
    // `contains` is folded into the parent card; anything else means she has
    // not said yet, and an undrawn edge is worse than an undecided one.
    return e.config.rel === "contains" ? null : "undecided";
  }
  return "invalid";
}

function fieldsOf(n: Node): string[] {
  const f = n.config?.fields;
  return Array.isArray(f) ? (f as string[]) : [];
}

function checksHostedBy(
  hostId: NodeId,
  hostOf: Map<NodeId, NodeId>,
  board: Board,
): Node[] {
  return board.nodes.filter((n) => hostOf.get(n.id) === hostId);
}

function childRows(
  parentId: NodeId,
  parentOf: Map<NodeId, NodeId>,
  hostOf: Map<NodeId, NodeId>,
  board: Board,
  depth: number,
  covers: NodeId[],
): ChildRow[] {
  const out: ChildRow[] = [];
  for (const n of board.nodes) {
    if (parentOf.get(n.id) !== parentId) continue;
    covers.push(n.id);
    const checks = checksHostedBy(n.id, hostOf, board);
    for (const c of checks) covers.push(c.id);
    out.push({
      kind: "child",
      node: n,
      depth,
      fields: fieldsOf(n).map((name) => ({ kind: "field", name }) as FieldRow),
      checks,
    });
    // Nesting is legal — a thing inside a thing inside a thing — so recurse.
    out.push(...childRows(n.id, parentOf, hostOf, board, depth + 1, covers));
  }
  return out;
}

function countChecks(rows: Row[]): number {
  let n = 0;
  for (const r of rows) {
    if (r.kind === "check") n++;
    else if (r.kind === "child") n += r.checks.length;
  }
  return n;
}
