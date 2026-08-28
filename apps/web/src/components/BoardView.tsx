"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ConnectionMode,
  useReactFlow,
  ReactFlowProvider,
  addEdge,
  applyNodeChanges,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type Connection,
  type NodeChange,
} from "@xyflow/react";
import type { Board } from "@engine/compiler/client";
import { fold } from "../fold";
import type { BoardMeta, CommentRow } from "../store/types";
import { useRouter } from "next/navigation";
import {
  answerComment, connect, createNode, deleteNode, disconnect,
  countCommentsOn, explainInstead, moveNode, rejectComment, renameNode,
  requestReview, reviewStatus, setConfigKey, setEdgeConfig, submitFreeze,
} from "../actions";
import { unfold } from "../actions";
import Palette from "./Palette";
import EdgeInspector from "./EdgeInspector";
import BoardCard from "./BoardCard";
import CommentPanel from "./CommentPanel";

const nodeTypes = { boardCard: BoardCard };

const EDGE_COLOR: Record<string, string> = {
  derive: "#5b7590",
  read: "#93a1ae",
  outcome: "#7a6bb0",
  value: "#7a6bb0",
  undecided: "#b9791b",
  report: "#5b7590",
  invalid: "#b4453f",
  join: "#0f8b7e",
  merge: "#0f8b7e",
  // Containment is normally the indentation on a card rather than a line. A
  // drawn one means its fold was cancelled by a second edge to the same pair.
  contain: "#0f8b7e",
  input: "#93a1ae",
  fail: "#b4453f",
};

export default function BoardView({
  meta,
  board,
  comments,
  findingCount,
  blockingCount,
  live,
}: {
  meta: BoardMeta;
  board: Board;
  comments: CommentRow[];
  findingCount: number;
  blockingCount: number;
  live: { code: string; nodeId: string | null; edgeId: string | null; say: string }[];
}) {
  const router = useRouter();
  const [runId, setRunId] = useState<string | null>(null);
  const [reviewedAt, setReviewedAt] = useState<number | null>(null);
  const [showPanel, setShowPanel] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  // Errors live on the comment they came from. A failure routed to a panel she
  // has collapsed is indistinguishable from nothing happening.
  const [commentErrors, setCommentErrors] = useState<Record<string, string>>({});
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [freeze, setFreeze] = useState<Awaited<ReturnType<typeof submitFreeze>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const folded = useMemo(() => fold(board), [board]);

  const ambiguous = useMemo(() => {
    const seen = new Map<string, string[]>();
    for (const n of board.nodes) {
      const k = n.label.trim().toLowerCase();
      if (k) seen.set(k, [...(seen.get(k) ?? []), n.id]);
    }
    return new Set([...seen.values()].filter((ids) => ids.length > 1).flat());
  }, [board.nodes]);

  // Live findings are status, not conversation. They land on the card that
  // stands for the node — including one that was folded away, or the board
  // looks clean while freeze is blocked.
  const liveByCard = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const f of live) {
      const anchor = f.nodeId ?? (f.edgeId ? edgeHome(board, f.edgeId) : null);
      const card = anchor ? folded.cardOf[anchor] : null;
      if (!card) continue;
      (out[card] ??= []).push(f.say);
    }
    // A card can stand for several nodes, so the same finding on each of them
    // rendered the same line once per node. One finding, one marker.
    for (const k of Object.keys(out)) out[k] = [...new Set(out[k])];
    return out;
  }, [live, folded, board]);

  // The worker runs in its own process, so the page has no way to know a round
  // landed. Poll the RUN, not the comment count: a round that fails, or that
  // writes nothing because everything was already asked, is a finished round —
  // and watching for new comments meant those spun forever.
  useEffect(() => {
    if (!runId) return;
    let stop = false;
    const tick = async () => {
      const status = await reviewStatus(runId);
      if (stop) return;
      if (status === "done" || status === "gone") {
        setRunId(null);
        setReviewedAt(Date.now());
        router.refresh();
      } else if (status === "failed") {
        setRunId(null);
        setError("The review didn't finish. Check the worker's output.");
      } else {
        setTimeout(tick, 700);
      }
    };
    void tick();
    return () => { stop = true; };
  }, [runId, router]);

  // A comment anchored to a folded node belongs on the card that stands for it,
  // so a pin is never orphaned by the renderer's choice to fold something away.
  const pinsByCard = useMemo(() => {
    const out: Record<string, CommentRow[]> = {};
    for (const c of comments) {
      const anchor = c.node_id ?? (c.edge_id ? edgeHome(board, c.edge_id) : null);
      const card = anchor ? folded.cardOf[anchor] : null;
      if (!card) continue;
      (out[card] ??= []).push(c);
    }
    return out;
  }, [comments, folded, board]);

  const answer = useCallback(
    (commentId: string, value: unknown) =>
      start(async () => {
        setError(null);
        const r = await answerComment(meta.id, commentId, value);
        if (!r.ok) setCommentErrors((e) => ({ ...e, [commentId]: r.error }));
        else {
          setCommentErrors(({ [commentId]: _gone, ...rest }) => rest);
          setOpenCard(null);
        }
      }),
    [meta.id],
  );

  const reject = useCallback(
    (commentId: string) =>
      start(async () => {
        setError(null);
        const r = await rejectComment(meta.id, commentId);
        if (!r.ok) setCommentErrors((e) => ({ ...e, [commentId]: r.error }));
      }),
    [meta.id],
  );

  /**
   * Drawing a connection says only that these two are related. What the
   * relationship IS — one sits inside the other, they pair up, one is built
   * from several — is the compiler's question, because guessing it is exactly
   * how a join silently compiles as an extraction.
   *
   * For two records that question can't wait: the edge is ambiguous the moment
   * it exists. So the inspector opens on it straight away rather than leaving
   * her to discover it later.
   */
  const makeEdge = useCallback(
    (from: string, to: string) =>
      start(async () => {
        setError(null);
        setConnectFrom(null);
        const bothRecords =
          board.nodes.find((n) => n.id === from)?.primitive === "artifact" &&
          board.nodes.find((n) => n.id === to)?.primitive === "artifact";
        const id = await connect(meta.id, from, to);
        if (bothRecords && id) setSelectedEdge(id);
      }),
    [meta.id, board.nodes],
  );

  const setFields = useCallback(
    (nodeId: string, fields: string[]) =>
      start(async () => {
        setError(null);
        const r = await setConfigKey(meta.id, nodeId, "fields", fields);
        if (!r.ok) setError(r.error);
      }),
    [meta.id],
  );

  const rename = useCallback(
    (nodeId: string, label: string) =>
      start(async () => { await renameNode(meta.id, nodeId, label); }),
    [meta.id],
  );

  const explain = useCallback(
    (commentId: string, text: string) =>
      start(async () => {
        setError(null);
        const r = await explainInstead(meta.id, commentId, text);
        if (!r.ok) setCommentErrors((e) => ({ ...e, [commentId]: r.error }));
      }),
    [meta.id],
  );

  /**
   * Pull a folded record back out into a card of its own.
   *
   * Folding is a view rule: a record contained by another is drawn as a row
   * inside it. That is right until she wants to work on the contained thing —
   * point a second check at it, give it its own children — at which point a
   * row is a cage. Unfolding drops the containment edge, so it becomes its own
   * card, and the compiler immediately asks how the two relate now.
   */
  const pullOut = useCallback(
    (nodeId: string) =>
      start(async () => {
        setError(null);
        const r = await unfold(meta.id, nodeId);
        if (!r.ok) setError(r.error);
      }),
    [meta.id],
  );

  const buildNodes = useCallback(
    (): FlowNode[] =>
      folded.cards.map((card) => ({
        id: card.node.id,
        type: "boardCard",
        position: { x: card.node.x ?? 0, y: card.node.y ?? 0 },
        data: {
          card,
          pins: pinsByCard[card.node.id] ?? [],
          open: openCard === card.node.id,
          pending,
          onTogglePin: (id: string) => setOpenCard((cur) => (cur === id ? null : id)),
          onAnswer: answer,
          onReject: reject,
          onFields: setFields,
          onRename: rename,
          onExplain: explain,
          errors: commentErrors,
          live: liveByCard[card.node.id] ?? [],
          ambiguous,
          onUnfold: pullOut,
          onChildFields: setFields,
          onChildRename: rename,
          connectFrom,
          onArmConnect: (id: string) => setConnectFrom((cur) => (cur === id ? null : id)),
          onCompleteConnect: (id: string) => {
            if (connectFrom && connectFrom !== id) makeEdge(connectFrom, id);
          },
        },
      })),
    [folded, pinsByCard, openCard, pending, answer, reject, explain,
     setFields, rename, commentErrors, connectFrom, makeEdge, liveByCard, pullOut,
     ambiguous],
  );

  // React Flow is controlled here, so nothing moves unless we apply the changes
  // it reports. Without onNodesChange the cards look draggable and simply are
  // not — which is exactly how it looked.
  const [nodes, setNodes] = useState<FlowNode[]>(buildNodes);
  useEffect(() => setNodes(buildNodes()), [buildNodes]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((cur) => applyNodeChanges(changes, cur)),
    [],
  );

  // Drawing an edge says only that these two are connected. What the
  // connection MEANS — contains, pairs with, built from — is a question the
  // compiler asks, because guessing it is how a join silently compiles as an
  // extraction.
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      makeEdge(c.source, c.target);
    },
    [makeEdge],
  );

  const flowEdges: FlowEdge[] = useMemo(
    () =>
      folded.edges.map((e) => ({
        id: e.edge.id,
        source: e.fromCard,
        target: e.toCard,
        label: e.label,
        animated: e.kind === "fail",
        style: {
          stroke: EDGE_COLOR[e.kind] ?? "#93a1ae",
          strokeWidth:
            e.kind === "fail" || e.kind === "undecided" || e.kind === "invalid" ? 2 : 1.4,
          strokeDasharray:
            e.kind === "fail" ? "6 4"
            : e.kind === "undecided" ? "4 4"
            : e.kind === "invalid" ? "2 3"
            : undefined,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR[e.kind] ?? "#93a1ae" },
      })),
    [folded],
  );

  const unsettled = comments.filter((c) => c.status === "open" || c.status === "answered");

  return (
    <div className="shell">
      <header className="topbar">
        <h1>{meta.title}</h1>
        <span className="sub">
          {board.nodes.length} nodes drawn as {folded.cards.length} cards
        </span>
        <span className={`status ${meta.status}`}>{meta.status}</span>
        <div className="spacer" />
        {findingCount === 0 ? (
          <span className="ready">Ready to submit — nothing left to ask</span>
        ) : (
          <span className="sub">
            {findingCount} to resolve
            {unsettled.length > 0 ? ` · ${unsettled.length} asked` : ""}
          </span>
        )}
        <button
          disabled={pending || runId != null || meta.status === "frozen"}
          onClick={() =>
            start(async () => {
              setError(null);
              const { runId: id } = await requestReview(meta.id);
              setRunId(id);
            })
          }
        >
          {runId ? "Reviewing…" : "Review"}
        </button>
        <button onClick={() => setShowPalette((v) => !v)}>
          {showPalette ? "Done adding" : "Add card"}
        </button>
        <button onClick={() => setShowPanel((v) => !v)}>
          {showPanel ? "Hide queue" : `Queue (${unsettled.length})`}
        </button>
        <button
          className="primary"
          disabled={pending || meta.status === "frozen"}
          onClick={() => start(async () => setFreeze(await submitFreeze(meta.id, slug(meta.title))))}
        >
          Submit
        </button>
      </header>

      <div className="body">
        {showPalette && (
          <Palette
            disabled={pending || meta.status === "frozen"}
            onAdd={(primitive, label, at) =>
              start(async () => {
                // Dropped into open space near the middle of what's drawn, so a
                // new card lands somewhere visible rather than at the origin.
                const xs = board.nodes.map((n) => n.x ?? 0);
                const ys = board.nodes.map((n) => n.y ?? 0);
                const x = at?.x ?? (xs.length ? Math.max(...xs) + 300 : 80);
                const y = at?.y ?? (ys.length ? Math.round(ys.reduce((a, b) => a + b, 0) / ys.length) : 120);
                await createNode(meta.id, primitive, label, x, y);
              })
            }
          />
        )}

        <FlowCanvas
          nodes={nodes}
          edges={flowEdges}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onMove={(id, x, y) => void moveNode(meta.id, id, x, y)}
          onDeleteNodes={(ids) =>
            start(async () => {
              for (const id of ids) {
                // Say what a delete costs before it happens: a card can carry
                // the entire history of why it looks the way it does.
                const attached = await countCommentsOn(meta.id, id);
                if (attached > 0) {
                  const ok = window.confirm(
                    `Delete this card? ${attached} comment${attached === 1 ? "" : "s"} about it will go too.`,
                  );
                  if (!ok) continue;
                }
                await deleteNode(meta.id, id);
              }
            })
          }
          onDeleteEdges={(ids) =>
            start(async () => { for (const id of ids) await disconnect(meta.id, id); })
          }
          onSelectEdge={(id) => { setSelectedEdge(id); setOpenCard(null); }}
          onClearSelection={() => {
            setOpenCard(null); setSelectedEdge(null); setConnectFrom(null);
          }}
          onDropOnto={(dragged, target) => {
            const d = board.nodes.find((x) => x.id === dragged);
            const t = board.nodes.find((x) => x.id === target);
            if (!d || !t) return;
            // A check dropped on a record means "look at that one".
            if (d.primitive === "policy" && t.primitive === "artifact") return makeEdge(t.id, d.id);
            // A record dropped on a check means the same thing, said the other way.
            if (d.primitive === "artifact" && t.primitive === "policy") return makeEdge(d.id, t.id);
            // Two records: makeEdge opens the relation question, which is the
            // only thing that could disambiguate it.
            if (d.primitive === "artifact" && t.primitive === "artifact") return makeEdge(d.id, t.id);
            // Anything else is just an overlap, so it stays a move.
            void moveNode(meta.id, d.id, d.x ?? 0, d.y ?? 0);
          }}
          onDropPrimitive={(primitive, at) =>
            start(async () => {
              await createNode(meta.id, primitive, defaultLabel(primitive), at.x, at.y);
            })
          }
        />

        {selectedEdge && board.edges.some((e) => e.id === selectedEdge) ? (
          <EdgeInspector
            edge={board.edges.find((e) => e.id === selectedEdge)!}
            board={board}
            pending={pending}
            onSet={(key, value) =>
              start(async () => {
                const r = await setEdgeConfig(meta.id, selectedEdge, key, value);
                if (!r.ok) setError(r.error);
              })
            }
            onDelete={() =>
              start(async () => {
                await disconnect(meta.id, selectedEdge);
                setSelectedEdge(null);
              })
            }
            onClose={() => setSelectedEdge(null)}
          />
        ) : null}

        <CommentPanel
          live={live}
          justReviewed={reviewedAt}
          blocking={blockingCount}
          collapsed={!showPanel || selectedEdge != null}
          comments={comments}
          openCard={openCard}
          cardOf={folded.cardOf}
          onFocus={(commentId) => {
            const c = comments.find((x) => x.id === commentId);
            const anchor = c?.node_id ?? (c?.edge_id ? edgeHome(board, c.edge_id) : null);
            setOpenCard(anchor ? (folded.cardOf[anchor] ?? null) : null);
          }}
          error={error}
          freeze={freeze}
          openCount={unsettled.length}
        />
      </div>
    </div>
  );
}

/**
 * The canvas, inside the provider — `screenToFlowPosition` only exists there,
 * and a card dropped from the palette has to land where she let go rather than
 * wherever the origin happens to be after panning.
 */
function FlowCanvas(props: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  onNodesChange: (c: NodeChange[]) => void;
  onConnect: (c: Connection) => void;
  onMove: (id: string, x: number, y: number) => void;
  onDeleteNodes: (ids: string[]) => void;
  onDeleteEdges: (ids: string[]) => void;
  onSelectEdge: (id: string) => void;
  onClearSelection: () => void;
  onDropPrimitive: (primitive: string, at: { x: number; y: number }) => void;
  onDropOnto: (dragged: string, target: string) => void;
}) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}

function Inner({
  nodes, edges, onNodesChange, onConnect, onMove, onDeleteNodes, onDeleteEdges,
  onSelectEdge, onClearSelection, onDropPrimitive, onDropOnto,
}: Parameters<typeof FlowCanvas>[0]) {
  const { screenToFlowPosition, getIntersectingNodes } = useReactFlow();
  return (
    <div
      className="canvas-wrap"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
      onDrop={(e) => {
        const primitive = e.dataTransfer.getData("application/primitive");
        if (!primitive) return;
        e.preventDefault();
        onDropPrimitive(primitive, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        // x and y are stripped before hashing, so moving a card is not a change
        // to the process — persisting it can never alter a spec_hash.
        onNodeDragStop={(_, n) => {
          // There is no "move a node into another node". Containment comes from
          // edges, never from position — a check renders inside a record's card
          // because it reads that record, which is folding, not layout.
          //
          // But dropping one card on another plainly MEANS something, so it is
          // read as the edge gesture it obviously is, and goes through the same
          // mutation path a drawn edge does. Layout never changes meaning.
          const onto = getIntersectingNodes(n)[0];
          if (onto && onto.id !== n.id) {
            onDropOnto(n.id, onto.id);
            return;
          }
          onMove(n.id, Math.round(n.position.x), Math.round(n.position.y));
        }}
        onConnect={onConnect}
        onNodesDelete={(ns) => onDeleteNodes(ns.map((n) => n.id))}
        onEdgesDelete={(es) => onDeleteEdges(es.map((e) => e.id))}
        onEdgeClick={(_, e) => onSelectEdge(e.id)}
        onPaneClick={onClearSelection}
        nodeTypes={nodeTypes}
        // Loose: a connection lands anywhere on the target card, not only on a
        // 9px handle. Drawing an edge is the second most common action here and
        // was effectively impossible to hit.
        connectionMode={ConnectionMode.Loose}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#222735" gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

/** A dropped card is unnamed until she types — the label is hers, not ours. */
function defaultLabel(primitive: string): string {
  return { channel: "New channel", artifact: "New thing", policy: "New check", output: "New result" }[
    primitive
  ] ?? "New card";
}

/** An edge-anchored comment pins to the card its source node lives on. */
function edgeHome(board: Board, edgeId: string): string | null {
  return board.edges.find((e) => e.id === edgeId)?.from ?? null;
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
