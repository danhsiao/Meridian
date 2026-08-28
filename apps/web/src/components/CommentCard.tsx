"use client";

// One comment, rendered the same whether it's floating on the canvas next to
// its node or listed in the queue.
//
// Three things this has to get right:
//
//   Declining must not do the thing. Answering applies the comment's mutation,
//   so an option marked `rejects` routes to reject instead — otherwise "No,
//   they're unrelated" runs the add_edge it was declining.
//
//   Nothing happens without warning. Every comment shows what accepting will
//   change, generated from the mutation, before she commits.
//
//   No multiple choice is a dead end. Every picker ends in "None of these",
//   which opens free text rather than leaving her stuck.

import { useState } from "react";
import { parseAnswer } from "@engine/compiler/client";
import type { CommentRow } from "../store/types";

export default function CommentCard({
  comment,
  pending,
  onAnswer,
  onReject,
  onExplain,
  error,
  compact,
}: {
  comment: CommentRow;
  pending: boolean;
  /** Shown inline. A failed answer must never look like nothing happened. */
  error?: string | null;
  onAnswer: (value: unknown) => void;
  onReject: () => void;
  onExplain: (text: string) => void;
  compact?: boolean;
}) {
  const [text, setText] = useState("");
  const [explaining, setExplaining] = useState(false);
  const c = comment;
  const settled = c.status === "resolved" || c.status === "rejected";

  return (
    <div className={`ccard ${compact ? "compact" : ""}`} onClick={(e) => e.stopPropagation()}>
      <div className="comment-meta">
        <span className={`rank ${c.rank}`}>{c.rank}</span>
        <span>{c.id}</span>
      </div>

      <div className="comment-body">{c.body}</div>

      {/* Showing, not asking. The playback is written in her own field names —
          she should be able to agree or disagree without learning a word of
          the type system, so the structure behind it stays folded away. */}
      {readsAs(c.proposal) && (
        <div className="playback">
          {readsAs(c.proposal)}
          <details className="playback-detail">
            <summary>what that sets up</summary>
            <pre>{JSON.stringify(stripPlayback(c.proposal), null, 2)}</pre>
          </details>
        </div>
      )}

      {error && <div className="ccard-error">{error}</div>}

      {/* Her words, read back. "None of these" is information about the board,
          so it stays open — but it must not look like nothing was sent. */}
      {saidInstead(c) && (
        <div className="said">
          <span className="said-label">You said</span>
          {saidInstead(c)}
          <span className="said-note">
            Still open — this needs the board to change, not just an answer.
          </span>
        </div>
      )}

      {settled ? (
        <div className="answered">
          {c.status === "rejected" ? "declined" : `answered: ${fmt(c.answer)}`}
        </div>
      ) : explaining ? (
        <div className="answer-text">
          <Grow
            autoFocus
            value={text}
            placeholder="tell me in your own words"
            disabled={pending}
            onChange={setText}
            onSubmit={() => text.trim() && onExplain(text.trim())}
            onEscape={() => setExplaining(false)}
          />
          <button disabled={pending || !text.trim()} onClick={() => onExplain(text.trim())}>
            Send
          </button>
        </div>
      ) : saidInstead(c) ? null : c.answer_kind === "choice" ? (
        <>
          <div className="choices">
            {(c.options ?? []).map((o) => (
              <button
                key={String(o.value)}
                className={`choice ${o.rejects ? "declining" : ""} ${o.escape ? "escape" : ""}`}
                disabled={pending}
                onClick={() => {
                  if (o.escape) setExplaining(true);
                  else if (o.rejects) onReject();
                  else onAnswer(o.value);
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
          {/* Say what will happen before it happens. */}
          {c.preview && <div className="preview">ⓘ {c.preview}</div>}
        </>
      ) : (
        <div className="answer-text">
          <Grow
            autoFocus={!compact}
            value={text}
            placeholder="type your answer"
            disabled={pending}
            onChange={setText}
            onSubmit={() => text.trim() && onAnswer(parseFor(c, text))}
          />
          <button
            disabled={pending || !text.trim()}
            onClick={() => onAnswer(parseFor(c, text))}
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Three lines minimum, growing with what she types. She is describing a process
 * in her own words — a one-line input that scrolls sideways makes her write
 * less than she means to, and the description is the agent's primary input.
 */
function Grow({
  value, placeholder, disabled, autoFocus, onChange, onSubmit, onEscape,
}: {
  value: string;
  placeholder: string;
  disabled: boolean;
  autoFocus?: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onEscape?: () => void;
}) {
  return (
    <textarea
      className="grow"
      autoFocus={autoFocus}
      rows={3}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => {
        onChange(e.target.value);
        e.target.style.height = "auto";
        e.target.style.height = `${e.target.scrollHeight}px`;
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        // Enter sends; shift-enter is a new line, because some answers are
        // genuinely a paragraph.
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(); }
        if (e.key === "Escape") onEscape?.();
      }}
    />
  );
}

/**
 * A free-text answer, in the shape its key holds.
 *
 * This used to split on any comma, which is right for "what values do you pull
 * out of this?" and wrong for every question answered with a sentence. The key
 * decides now, and only the registry knows which keys hold lists — so the
 * canvas asks the compiler rather than guessing from punctuation.
 */
function parseFor(c: CommentRow, raw: string): unknown {
  const key = (c.mutation as { key?: unknown } | null)?.key;
  return typeof key === "string" ? parseAnswer(key, raw) : raw.trim();
}

/** The resolution in her words, if the agent produced one. */
function readsAs(p: Record<string, unknown> | null): string | null {
  const v = p?.reads_as;
  return typeof v === "string" && v.trim() ? v : null;
}

function stripPlayback(p: Record<string, unknown> | null): Record<string, unknown> {
  const { reads_as: _shown, ...rest } = p ?? {};
  return rest;
}

/** The text she typed after picking "none of these", if she did. */
function saidInstead(c: CommentRow): string | null {
  const a = c.answer as { none_of_these?: string } | null;
  return a && typeof a === "object" && a.none_of_these ? a.none_of_these : null;
}

function fmt(v: unknown): string {
  if (v == null) return "—";
  return typeof v === "string" ? v : JSON.stringify(v);
}
