import { notFound } from "next/navigation";
import { blockingFindings, elaborate } from "@engine/compiler/client";
import { store } from "../../../src/store/postgres";
import BoardView from "../../../src/components/BoardView";

export const dynamic = "force-dynamic";

/** Status, not a question — so it is a statement, not a prompt. */
function liveWording(code: string): string {
  return (
    {
      unreachable_node: "nothing reaches this yet — draw a line into it",
      unbound_policy: "this doesn't look at anything yet — connect what it checks",
      no_terminal_path: "this doesn't feed into anything yet",
      data_cycle: "this ends up depending on itself",
      edge_not_expressible: "this connection can't be built",
    }[code] ?? code.replace(/_/g, " ")
  );
}

export default async function BoardPage({ params }: { params: Promise<{ mapId: string }> }) {
  const { mapId } = await params;
  const found = await store.getBoard(mapId);
  if (!found) notFound();

  const comments = await store.listComments(mapId);
  // Findings are recomputed on every load rather than cached: the board is the
  // source of truth, and a stale finding is worse than a slow one.
  const { findings } = elaborate(found.board);
  // What still stops a freeze, as opposed to what has merely been asked. The
  // two differ: a finding can block without yet being a fair question.
  const blocking = blockingFindings(findings);

  return (
    <BoardView
      meta={found.meta}
      board={found.board}
      comments={comments}
      findingCount={findings.length}
      blockingCount={blocking.length}
      // Findings the agent will never raise as a question — the fix is hers to
      // make directly. They still block freeze, so they have to be visible.
      live={blocking
        .filter((f) => !f.askable)
        .map((f) => ({
          code: f.code,
          nodeId: "node_id" in f.anchor ? f.anchor.node_id : null,
          edgeId: "edge_id" in f.anchor ? f.anchor.edge_id : null,
          say: liveWording(f.code),
        }))}
    />
  );
}
