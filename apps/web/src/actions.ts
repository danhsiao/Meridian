"use server";

// Server actions. Every one of these writes rows and nothing else — the
// browser never calls the review agent, and the review agent never calls the
// browser. Clicking Review inserts a `review_runs` row; a trigger fires
// pg_notify; the worker wakes on LISTEN. That indirection is the architecture,
// not ceremony: it's what lets review take four seconds without blocking the
// canvas, and what lets the CLI participate without knowing the UI exists.

import { revalidatePath } from "next/cache";
import { store } from "./store/postgres";

export async function requestReview(mapId: string) {
  const { runId, round } = await store.requestReview(mapId);
  revalidatePath(`/boards/${mapId}`);
  return { runId, round };
}

export async function reviewStatus(runId: string) {
  return store.reviewStatus(runId);
}

export async function answerComment(mapId: string, commentId: string, answer: unknown) {
  try {
    await store.answerComment(mapId, commentId, answer);
    revalidatePath(`/boards/${mapId}`);
    return { ok: true as const };
  } catch (e) {
    // The transaction rolled back, so the board and the comment are both
    // untouched. Surfacing the reason beats a silent no-op.
    return { ok: false as const, error: (e as Error).message };
  }
}

/**
 * She picked "none of these". The option set came from her board, so this is
 * information about the board, not an answer to the question — it is recorded
 * against the comment and the comment stays open. What happens next differs by
 * tier: an extensible key captures a capability gap, a closed one redirects,
 * and a graph-derived one means the board is missing something.
 */
export async function explainInstead(mapId: string, commentId: string, text: string) {
  try {
    await store.explainInstead(mapId, commentId, text);
    revalidatePath(`/boards/${mapId}`);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

export async function rejectComment(mapId: string, commentId: string) {
  try {
    await store.rejectComment(mapId, commentId);
    revalidatePath(`/boards/${mapId}`);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

export async function submitFreeze(mapId: string, processId: string) {
  const result = await store.freezeBoard(mapId, processId);
  revalidatePath(`/boards/${mapId}`);
  return result;
}

/**
 * Dragging a card. x and y are stripped by canonical() before hashing, for the
 * same reason a compiler ignores whitespace — so this can never change a
 * spec_hash, and it deliberately does not revalidate: the client already moved
 * the node, and a round trip would fight the drag.
 */
export async function moveNode(mapId: string, nodeId: string, x: number, y: number) {
  await store.moveNode(mapId, nodeId, x, y);
}

// ── authoring ───────────────────────────────────────────────────────────
// She builds: drags cards on, names them, connects them. Nothing here fills
// anything in for her — a new card carries a primitive, a label and a
// position, and every remaining key is a question the compiler will ask.

export async function createBoard(title: string) {
  const id = await store.createBoard(title);
  revalidatePath("/");
  return id;
}

export async function createNode(
  mapId: string, primitive: string, label: string, x: number, y: number,
) {
  const id = await store.createNode(mapId, primitive, label, x, y);
  revalidatePath(`/boards/${mapId}`);
  return id;
}

export async function renameNode(mapId: string, nodeId: string, label: string) {
  await store.renameNode(mapId, nodeId, label);
  revalidatePath(`/boards/${mapId}`);
}

export async function deleteNode(mapId: string, nodeId: string) {
  await store.deleteNode(mapId, nodeId);
  revalidatePath(`/boards/${mapId}`);
}

export async function connect(mapId: string, from: string, to: string) {
  const id = await store.connect(mapId, from, to);
  revalidatePath(`/boards/${mapId}`);
  return id;
}

export async function disconnect(mapId: string, edgeId: string) {
  await store.disconnect(mapId, edgeId);
  revalidatePath(`/boards/${mapId}`);
}

/**
 * Typing a value directly. It runs through the compiler's applier, exactly as
 * an answered comment does — she is never editing a different board from the
 * one the review agent sees.
 */
export async function setConfigKey(
  mapId: string, nodeId: string, key: string, value: unknown,
) {
  try {
    await store.setConfigKey(mapId, nodeId, key, value);
    revalidatePath(`/boards/${mapId}`);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

export async function setEdgeConfig(mapId: string, edgeId: string, key: string, value: unknown) {
  try {
    await store.setEdgeConfig(mapId, edgeId, key, value);
    revalidatePath(`/boards/${mapId}`);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

/** How much history a delete would take with it, so the confirm can say so. */
export async function countCommentsOn(mapId: string, nodeId: string) {
  return store.countCommentsOn(mapId, nodeId);
}

/**
 * Give a folded record its own card again.
 *
 * Folding is a rendering rule, so "unfold" has to be a real edit rather than a
 * view toggle: it removes the containment edge that caused the folding. The
 * compiler then asks how the two relate now, which is the honest consequence —
 * she has said they aren't parent and child any more.
 */
export async function unfold(mapId: string, nodeId: string) {
  try {
    await store.unfold(mapId, nodeId);
    revalidatePath(`/boards/${mapId}`);
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}
