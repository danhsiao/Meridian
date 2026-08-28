"use client";

// The four primitives, with the sentence that explains each one.
//
// The design rule is that a primitive you can't explain to a non-engineer in
// one sentence doesn't belong in the grammar — so the palette shows the
// sentence rather than assuming she already knows what an "artifact" is. The
// internal names never appear; she sees Channel, Thing, Check, Result.

import { useState } from "react";
import { PRIMITIVES } from "../store/types";

export default function Palette({
  onAdd,
  disabled,
}: {
  /** x/y in flow coordinates when dropped; omitted when clicked. */
  onAdd: (primitive: string, label: string, at?: { x: number; y: number }) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [label, setLabel] = useState("");

  return (
    <div className="palette">
      <div className="palette-head">Add to the board</div>
      {PRIMITIVES.map((p) => (
        <div key={p.kind} className="palette-item">
          <button
            className={`palette-btn ${p.kind}`}
            disabled={disabled}
            // Drag to place it where she wants; click to place it for her.
            // Both, because dragging is discoverable and clicking is reliable.
            draggable={!disabled}
            onDragStart={(e) => {
              e.dataTransfer.setData("application/primitive", p.kind);
              e.dataTransfer.effectAllowed = "move";
            }}
            onClick={() => { setOpen(open === p.kind ? null : p.kind); setLabel(""); }}
          >
            <span className="palette-name">{p.name}</span>
            <span className="palette-one-liner">{p.one_liner}</span>
            <span className="palette-eg">{p.example}</span>
          </button>

          {open === p.kind && (
            <div className="palette-form">
              <input
                autoFocus
                value={label}
                placeholder={`What do you call it?`}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && label.trim()) {
                    onAdd(p.kind, label.trim());
                    setOpen(null);
                    setLabel("");
                  }
                  if (e.key === "Escape") setOpen(null);
                }}
              />
              <button
                className="primary"
                disabled={!label.trim()}
                onClick={() => { onAdd(p.kind, label.trim()); setOpen(null); setLabel(""); }}
              >
                Add
              </button>
            </div>
          )}
        </div>
      ))}
      <p className="palette-hint">Drag one onto the board, or click to add it.</p>
      <p className="palette-note">
        A new card starts empty on purpose. What it holds, what identifies it and
        what a check actually checks are questions the review agent asks — the
        board is where you say what you know, not a form to fill in.
      </p>
    </div>
  );
}
