"use client";

// Typing fields straight onto a card.
//
// She can always say what she already knows; the review agent is for what she
// didn't say. Both paths write through the compiler's applier, so there is one
// board and one set of rules, not a fast path and a checked path.

import { useEffect, useRef, useState } from "react";

export default function FieldEditor({
  fields,
  disabled,
  onChange,
}: {
  fields: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const [adding, setAdding] = useState("");
  // Typing is local; committing is not. Calling onChange per keystroke sent a
  // mutation, revalidated the page and remounted this node — so the input was
  // torn down after the first character. Commit on blur or Enter instead.
  const [draft, setDraft] = useState(fields);
  const dirty = useRef(false);

  // Accept upstream changes only when she isn't mid-edit, so an answered
  // comment that adds a value doesn't overwrite what she is typing.
  useEffect(() => {
    if (!dirty.current) setDraft(fields);
  }, [fields]);

  const commit = (next: string[]) => {
    dirty.current = false;
    const cleaned = next.map((f) => f.trim()).filter(Boolean);
    if (cleaned.join("\u0000") === fields.join("\u0000")) {
      setDraft(fields);
      return;
    }
    setDraft(cleaned);
    onChange(cleaned);
  };

  return (
    <div className="fields" onClick={(e) => e.stopPropagation()}>
      {draft.map((f, i) => (
        <div className="field-row" key={i}>
          <input
            className="field-input nodrag"
            value={f}
            disabled={disabled}
            onChange={(e) => {
              dirty.current = true;
              setDraft((cur) => cur.map((v, j) => (j === i ? e.target.value : v)));
            }}
            onBlur={() => commit(draft)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") { dirty.current = false; setDraft(fields); }
            }}
          />
          <button
            className="field-x nodrag"
            disabled={disabled}
            title="remove"
            onClick={() => commit(draft.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}

      <div className="field-row">
        <input
          className="field-input add nodrag"
          value={adding}
          placeholder="+ add a value"
          disabled={disabled}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && adding.trim()) {
              commit([...draft, adding.trim()]);
              setAdding("");
            }
            if (e.key === "Escape") setAdding("");
          }}
          onBlur={() => {
            if (adding.trim()) {
              commit([...draft, adding.trim()]);
              setAdding("");
            }
          }}
        />
      </div>
    </div>
  );
}
