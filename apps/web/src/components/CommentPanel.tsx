"use client";

// The backlog, not the loop.
//
// Answering happens on the canvas, next to the node the comment is about —
// that's the whole reason comments are pins rather than a chat sidebar. This
// panel exists because a queue is genuinely useful when there are twelve of
// them: it says what's left and in what order, and clicking a row flies the
// pin open on the card. It never offers its own answer affordance, so there is
// exactly one place to answer and no chance of two diverging.

import type { CommentRow } from "../store/types";

export default function CommentPanel({
  live,
  justReviewed,
  blocking,
  collapsed,
  comments,
  openCard,
  cardOf,
  onFocus,
  error,
  freeze,
  openCount,
}: {
  live: { code: string; nodeId: string | null; say: string }[];
  justReviewed: number | null;
  blocking: number;
  collapsed: boolean;
  comments: CommentRow[];
  openCard: string | null;
  cardOf: Record<string, string>;
  onFocus: (commentId: string) => void;
  error: string | null;
  freeze:
    | { ok: true; specHash: string; version: number }
    | { ok: false; nodeIds: string[]; reasons: string[] }
    | null;
  openCount: number;
}) {
  return (
    <aside className={`panel ${collapsed ? "collapsed" : ""}`}>
      <div className="panel-head">
        <h2>Review queue</h2>
        <span className="badge">{openCount} open</span>
      </div>

      <div className="panel-list">
        {live.length > 0 && (
          <div className="live-list">
            <div className="live-list-head">Blocking freeze — fix these on the board</div>
            {live.map((f, i) => (
              <div className="live-list-row" key={i}>{f.say}</div>
            ))}
            <p className="live-list-note">
              These aren't questions. The board doesn't know what should connect
              where — that's yours to draw.
            </p>
          </div>
        )}
        {justReviewed != null && openCount === 0 && blocking === 0 && (
          <div className="all-clear">
            <strong>Nothing left to ask.</strong>
            <p>
              Every question this board raises has been answered. Submit to
              freeze it — that runs the type check and, if it passes, writes an
              immutable spec the coding agent can build from.
            </p>
          </div>
        )}

        {comments.length === 0 && justReviewed == null && (
          <div className="hint">
            No comments yet. Press <code>Review</code> — that inserts a{" "}
            <code>review_runs</code> row and the worker wakes on <code>LISTEN</code>.
            Nothing here calls the agent directly; the database is the bus.
          </div>
        )}

        {comments.map((c) => {
          const settled = c.status === "resolved" || c.status === "rejected";
          const anchor = c.node_id ?? "";
          const focused = openCard != null && cardOf[anchor] === openCard;
          return (
            <button
              key={c.id}
              className={`queue-row ${settled ? "settled" : ""} ${focused ? "active" : ""}`}
              onClick={() => onFocus(c.id)}
            >
              <span className={`rank ${c.rank}`}>{c.rank}</span>
              <span className="queue-body">{c.body}</span>
              {settled && <span className="queue-done">{c.status === "rejected" ? "skipped" : "done"}</span>}
            </button>
          );
        })}
      </div>

      {error && <p className="freeze-result fail">{error}</p>}

      {freeze && (
        <div className={`freeze-result ${freeze.ok ? "ok" : "fail"}`}>
          {freeze.ok ? (
            <>
              Frozen as v{freeze.version}.
              <div className="ids">{freeze.specHash}</div>
            </>
          ) : (
            <>
              Not yet — {[...new Set(freeze.reasons)].join(", ")}.
              <div className="ids">{freeze.nodeIds.join("  ")}</div>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
