"use client";

// One card, with its diagnostics attached to it.
//
// The renderer folds what's obvious — a contained record becomes an indented
// row, a check that reads exactly this record becomes a row and a badge — so
// nine nodes draw as four cards. Every one of the nine is still in the spec;
// `covers` is what keeps a pin attached to the node it belongs to even when
// that node has no box of its own.
//
// Comments open ON the canvas, next to the thing they are about. A compiler
// error names a line number because a diagnostic detached from its location is
// worth far less — this is the same argument, which is why the pin is the
// primary surface and the side panel is only a backlog of the same rows.

import { Handle, NodeToolbar, Position, type NodeProps } from "@xyflow/react";
import type { Card } from "../fold";
import type { CommentRow } from "../store/types";
import CommentCard from "./CommentCard";
import FieldEditor from "./FieldEditor";
import EditableLabel from "./EditableLabel";

/**
 * What this card knows, in her words. Deliberately not exhaustive — a card is a
 * summary and the inspector is the detail — but everything she can answer must
 * show up somewhere, or answering feels like shouting into a void.
 */
function summarise(node: { primitive: string; config: Record<string, unknown> }) {
  const c = node.config ?? {};
  const out: { key: string; value: string }[] = [];
  const say = (key: string, value: unknown) => {
    if (value == null || value === "") return;
    const text = Array.isArray(value)
      ? value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ")
      : typeof value === "object"
        ? Object.values(value as Record<string, unknown>).map(String).join(" · ")
        : String(value);
    out.push({ key, value: text.length > 90 ? `${text.slice(0, 88)}…` : text });
  };

  say("is", c.describes);
  if (node.primitive === "channel") { say("via", c.tool); say("matches", c.match); say("sends", c.request); }
  if (node.primitive === "artifact") { say("same one when", c.identity_key); say("found in", c.source_hint); }
  if (node.primitive === "policy") {
    const check = c.check as { relation?: string } | undefined;
    say("checks", check?.relation ?? (c.impl ? "a rule we wrote for you" : undefined));
    say("looks at", c.reads);
    say("on failure", c.on_fail === "halt" ? "stop the run" : c.on_fail ? "flag and carry on" : undefined);
    say("when blank", c.on_absent);
  }
  if (node.primitive === "output") {
    const rows = Array.isArray(c.rows) ? (c.rows as { label?: string }[]) : [];
    if (rows.length) say("reports", rows.map((r) => r.label).filter(Boolean).join(", "));
  }
  return out;
}

const KIND_COLOR: Record<string, string> = {
  channel: "var(--channel)",
  artifact: "var(--artifact)",
  policy: "var(--policy)",
  output: "var(--output)",
};

export interface BoardCardData {
  card: Card;
  /** Node ids sharing a label with another card, so the row can say so. */
  ambiguous: Set<string>;
  pins: CommentRow[];
  open: boolean;
  pending: boolean;
  onTogglePin: (cardId: string) => void;
  onAnswer: (commentId: string, value: unknown) => void;
  onReject: (commentId: string) => void;
  onFields: (nodeId: string, fields: string[]) => void;
  onRename: (nodeId: string, label: string) => void;
  onExplain: (commentId: string, text: string) => void;
  errors: Record<string, string>;
  /** Status the agent will never ask about — hers to fix directly. */
  live: string[];
  /** A folded row is still a node: it can be edited and pulled back out. */
  onUnfold: (nodeId: string) => void;
  onChildFields: (nodeId: string, fields: string[]) => void;
  onChildRename: (nodeId: string, label: string) => void;
  /** Click-to-connect: arm on one card, click another to finish. */
  connectFrom: string | null;
  onArmConnect: (nodeId: string) => void;
  onCompleteConnect: (nodeId: string) => void;
}

export default function BoardCard({ data }: NodeProps) {
  const {
    card, pins, open, pending, onTogglePin, onAnswer, onReject,
    onFields, onRename, onExplain, errors, live,
    onUnfold, onChildFields, onChildRename, ambiguous,
    connectFrom, onArmConnect, onCompleteConnect,
  } = data as unknown as BoardCardData;
  const armed = connectFrom === card.node.id;
  const isTarget = connectFrom != null && !armed;
  const node = card.node;
  const ownFields = Array.isArray(node.config?.fields) ? (node.config.fields as string[]) : [];

  const unsettled = pins.filter((p) => p.status === "open" || p.status === "answered");
  const settled = pins.filter((p) => p.status === "resolved" || p.status === "rejected");
  // Open questions first, then everything already answered — six months on,
  // every choice on this card should still trace to a question and an answer.
  const show = unsettled.length > 0 ? unsettled : pins;

  return (
    <>
      <Handle type="target" position={Position.Left} id="l" className="port" />
      <Handle type="target" position={Position.Top} id="t" className="port" />

      {/* Anchored to the node, drawn in screen space — it travels with the card
          when you drag, and doesn't shrink when you zoom out. */}
      <NodeToolbar isVisible={open && show.length > 0} position={Position.Right} offset={14}>
        {/* `nowheel` is React Flow's own opt-out. The onWheel handler below was
            not enough on its own: React Flow binds a NATIVE wheel listener to the
            pane, and a React synthetic event never reaches it, so scrolling the
            thread zoomed the canvas and the scrollbar was the only way down. */}
        <div className="thread nodrag nowheel" onWheel={(e) => e.stopPropagation()}>
          {show.length > 1 && (
            <div className="thread-head">
              {show.length} comments on {card.node.label}
            </div>
          )}
          {show.map((c) => (
            <CommentCard
              key={c.id}
              comment={c}
              pending={pending}
              compact
              onAnswer={(v) => onAnswer(c.id, v)}
              onReject={() => onReject(c.id)}
              onExplain={(t) => onExplain(c.id, t)}
              error={errors[c.id]}
            />
          ))}
          {unsettled.length > 0 && settled.length > 0 && (
            <details className="history">
              <summary>{settled.length} already answered</summary>
              {settled.map((c) => (
                <CommentCard
                  key={c.id}
                  comment={c}
                  pending={pending}
                  compact
                  onAnswer={() => {}}
                  onReject={() => {}}
                  onExplain={() => {}}
                />
              ))}
            </details>
          )}
        </div>
      </NodeToolbar>

      <div
        className={`card ${open ? "selected" : ""} ${isTarget ? "connect-target" : ""} ${
          live.length > 0 ? "blocked" : ""
        }`}
        onClick={() => { if (isTarget) onCompleteConnect(card.node.id); }}
      >
        {show.length > 0 && (
          <button
            className={`pin nodrag ${unsettled.length === 0 ? "resolved" : ""} ${open ? "open" : ""}`}
            title={show[0].body}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin(card.node.id);
            }}
          >
            {show.length}
          </button>
        )}

        {live.length > 0 && (
          <div className="live-marks" title={live.join("\n")}>
            {live.map((l, i) => (
              <div className="live-mark" key={i}>{l}</div>
            ))}
          </div>
        )}

        <div className="card-head" style={{ ["--kind" as string]: KIND_COLOR[card.node.primitive] }}>
          {/* Renaming is free: ids never come from labels, so calling a thing
              something else can't change what the spec calls it. */}
          <EditableLabel
            nodeId={node.id}
            label={node.label}
            className="card-title-input"
            disabled={pending}
            onRename={onRename}
          />
          {card.checkCount > 0 && <span className="badge">{card.checkCount} checks</span>}
          <span className="card-kind">{card.node.primitive}</span>
          {/* Dragging a handle works, but it depends on hitting a small target
              on the right edge. This does the same thing in two clicks. */}
          <button
            className={`card-connect nodrag ${armed ? "armed" : ""}`}
            disabled={pending}
            title={armed ? "Now click the card to connect to" : "Connect this to another card"}
            onClick={(e) => { e.stopPropagation(); onArmConnect(card.node.id); }}
          >
            {armed ? "pick one" : "→"}
          </button>
        </div>

        {/* What she has said so far. Answering a comment has to visibly change
            the card it was about, or the loop looks like it did nothing. */}
        {summarise(node).map((line, i) => (
          <div className="summary" key={i}>
            <span className="summary-key">{line.key}</span>
            <span className="summary-val">{line.value}</span>
          </div>
        ))}

        <div className="rows">
          {/* Only an artifact carries values, so only an artifact gets the
              editor. A check's subject is a question the compiler asks. */}
          {node.primitive === "artifact" && (
            <FieldEditor
              fields={ownFields}
              disabled={pending}
              onChange={(next) => onFields(node.id, next)}
            />
          )}
          {card.rows.length === 0 &&
            node.primitive !== "artifact" &&
            summarise(node).length === 0 && <div className="empty">nothing set yet</div>}
          {card.rows.map((row, i) => {
            // an artifact's own fields are rendered by the editor above
            if (row.kind === "field") return null;
            if (row.kind === "check") {
              return <div className="row check" key={row.node.id}>✓ {row.node.label}</div>;
            }
            return (
              <div key={row.node.id} className="child-block">
                <div className="row child" style={{ paddingLeft: 11 + row.depth * 12 }}>
                  {/* Folded is a way of DRAWING it, not a way of freezing it.
                      Everything here is still a node with its own row in the
                      store, so it stays editable. */}
                  <EditableLabel
                    nodeId={row.node.id}
                    label={row.node.label}
                    className="child-title-input"
                    disabled={pending}
                    onRename={onChildRename}
                  />
                  {/* Two rows with the same name are indistinguishable, which
                      is exactly what the duplicate_label question is about. */}
                  {ambiguous.has(row.node.id) && (
                    <span className="ambiguous" title="another card is called this too">
                      same name
                    </span>
                  )}
                  <button
                    className="unfold nodrag"
                    disabled={pending}
                    title="Give this its own card"
                    onClick={(e) => { e.stopPropagation(); onUnfold(row.node.id); }}
                  >
                    ⤢
                  </button>
                </div>
                <div style={{ paddingLeft: row.depth * 12 }}>
                  <FieldEditor
                    fields={row.fields.map((f) => f.name)}
                    disabled={pending}
                    onChange={(next) => onChildFields(row.node.id, next)}
                  />
                </div>
                {row.checks.map((c) => (
                  <div className="row check" key={c.id}
                       style={{ paddingLeft: 11 + row.depth * 12 + 12 }}>
                    ✓ {c.label}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      <Handle type="source" position={Position.Right} id="r" className="port" />
      <Handle type="source" position={Position.Bottom} id="b" className="port" />
    </>
  );
}
