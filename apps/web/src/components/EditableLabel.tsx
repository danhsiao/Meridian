"use client";

// A label you can type into, that can never end up on the wrong node.
//
// The bug this exists to prevent: the card used `defaultValue={node.label}` on
// an uncontrolled input, inside a list keyed by array index. React reads
// defaultValue once, at mount. When the folded children changed — a second
// record folding in, or the order shifting — React reused the same DOM subtree
// for a DIFFERENT node, and the input kept the text from the node it used to
// be. Blurring then committed that stale text against the new node's id, so a
// card she had called one thing silently took another card's name.
//
// Two rules, and both are needed:
//
//   The draft is keyed to the node id. When the id under this component
//   changes, the draft resets to that node's own label rather than carrying
//   the previous one across.
//
//   A commit is refused if the id changed while she was typing. Whatever she
//   was writing belonged to the node she started on, and writing it anywhere
//   else is worse than losing it.

import { useEffect, useRef, useState } from "react";

export default function EditableLabel({
  nodeId,
  label,
  className,
  disabled,
  onRename,
}: {
  nodeId: string;
  label: string;
  className?: string;
  disabled?: boolean;
  onRename: (nodeId: string, label: string) => void;
}) {
  const [draft, setDraft] = useState(label);
  const editing = useRef(false);
  const owner = useRef(nodeId);

  useEffect(() => {
    // A different node is under this component now, or the label changed
    // upstream while she wasn't typing.
    if (owner.current !== nodeId) {
      owner.current = nodeId;
      editing.current = false;
      setDraft(label);
      return;
    }
    if (!editing.current) setDraft(label);
  }, [nodeId, label]);

  const commit = () => {
    editing.current = false;
    const next = draft.trim();
    // The guard that matters: never write a name against an id it wasn't typed for.
    if (owner.current !== nodeId) {
      setDraft(label);
      return;
    }
    if (!next || next === label) {
      setDraft(label);
      return;
    }
    onRename(nodeId, next);
  };

  return (
    <input
      className={`${className ?? ""} nodrag`}
      value={draft}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => {
        editing.current = true;
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          editing.current = false;
          setDraft(label);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
