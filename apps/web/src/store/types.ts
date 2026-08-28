// The database is the bus. The browser writes rows; it never calls the review
// agent, and the CLI never calls the browser.
//
// One interface, two implementations: Postgres when DATABASE_URL is set, and an
// in-memory store seeded from examples/ when it isn't. The second exists so the
// canvas runs before credentials do — not as a mock, but as the same contract.

import type { Binding, Board, FindingCode, Mutation, Rank, Severity } from "@engine/compiler/client";

export type CommentStatus = "open" | "answered" | "rejected" | "resolved";

/** A diagnostic, persisted. Mirrors the `comments` table one-for-one. */
export interface CommentRow {
  map_id: string;
  id: string;
  node_id: string | null;
  edge_id: string | null;
  parent_id: string | null;
  supersedes: string | null;
  round: number;
  run_id: string | null;

  code: FindingCode;
  severity: Severity;
  rank: Rank;
  pass: "A" | "B";
  binding: Binding;
  answer_kind: "choice" | "text";

  author_type: "agent" | "user";
  author_id: string | null;
  body: string;
  options: { value: string | number; label: string; rejects?: true; escape?: true }[] | null;
  /** What accepting will change, derived from the mutation. Shown before she commits. */
  preview: string | null;
  answer: unknown;
  /** A `derived` key's resolution, played back in her field names. */
  proposal: Record<string, unknown> | null;
  /** Never null. A comment without one is a note, and a note changes nothing. */
  mutation: Mutation;
  status: CommentStatus;
  created_at: string;
}

export interface BoardMeta {
  id: string;
  title: string;
  status: "draft" | "frozen";
}

export interface BoardStore {
  listBoards(): Promise<BoardMeta[]>;
  getBoard(mapId: string): Promise<{ meta: BoardMeta; board: Board } | null>;
  listComments(mapId: string): Promise<CommentRow[]>;

  /** Insert agent comments for a round. Returns how many landed. */
  insertComments(rows: CommentRow[]): Promise<number>;

  /**
   * The transaction that makes the loop structural: apply the mutation to the
   * board AND settle the comment, together or not at all. If the mutation
   * throws, the comment stays open and the board is untouched.
   */
  answerComment(
    mapId: string,
    commentId: string,
    answer: unknown,
  ): Promise<{ board: Board; comment: CommentRow }>;

  /** Direct edits. She can always type what she knows; the agent asks about
   *  what she didn't. Both write the same config through the same validation. */
  setConfigKey(mapId: string, nodeId: string, key: string, value: unknown): Promise<void>;

  /** She drags a card on. It starts empty — the review agent asks the rest. */
  createNode(mapId: string, primitive: string, label: string, x: number, y: number): Promise<string>;
  renameNode(mapId: string, nodeId: string, label: string): Promise<void>;
  deleteNode(mapId: string, nodeId: string): Promise<void>;
  connect(mapId: string, from: string, to: string): Promise<string>;
  disconnect(mapId: string, edgeId: string): Promise<void>;
  setEdgeConfig(mapId: string, edgeId: string, key: string, value: unknown): Promise<void>;
  /** Drop the containment edge that folds this node into its parent. */
  unfold(mapId: string, nodeId: string): Promise<void>;
  /** Destructive actions confirm, and say how much is lost. */
  countCommentsOn(mapId: string, nodeId: string): Promise<number>;

  /** A blank whiteboard. Nothing is prefilled; the compiler has plenty to say. */
  createBoard(title: string): Promise<string>;

  /** Layout only. Stripped before hashing, so it cannot affect a spec. */
  moveNode(mapId: string, nodeId: string, x: number, y: number): Promise<void>;

  /** "None of these." Records her words; the comment stays open. */
  explainInstead(mapId: string, commentId: string, text: string): Promise<void>;

  /** Reject without applying. The comment is terminal; the board is unchanged. */
  rejectComment(mapId: string, commentId: string): Promise<CommentRow>;

  /** Queue a review round. The worker wakes on LISTEN, not on a call from here. */
  requestReview(mapId: string): Promise<{ runId: string; round: number }>;
  /** Whether that round has landed. The canvas has no other way to know. */
  reviewStatus(runId: string): Promise<"queued" | "running" | "done" | "failed" | "gone">;

  freezeBoard(
    mapId: string,
    processId: string,
  ): Promise<
    | { ok: true; specHash: string; version: number }
    | { ok: false; nodeIds: string[]; reasons: string[] }
  >;
}

/** The four primitives, as she meets them. One sentence each — the design rule
 *  is that a primitive you can't explain to a non-engineer in one sentence
 *  doesn't belong in the grammar. */
export const PRIMITIVES = [
  {
    kind: "channel" as const,
    name: "Channel",
    one_liner: "A connection to the outside world — things arrive from it, get sent to it, or both.",
    example: "An inbox you watch, a folder things land in, somewhere you send replies.",
  },
  {
    kind: "artifact" as const,
    name: "Thing",
    one_liner: "A typed thing with fields, pulled out of something unstructured or built from other things.",
    example: "A form someone sends you, a record inside it, a document attached to it.",
  },
  {
    kind: "policy" as const,
    name: "Check",
    one_liner: "A check over one or more things that comes out pass or fail.",
    example: "This field can't be blank. Every record needs a matching one somewhere else.",
  },
  {
    kind: "output" as const,
    name: "Result",
    one_liner: "What gets computed at the end — verdicts from checks, values from things.",
    example: "How many you processed, how many failed, which ones need chasing.",
  },
];
