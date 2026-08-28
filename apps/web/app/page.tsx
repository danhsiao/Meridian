import Link from "next/link";
import { store } from "../src/store/postgres";
import NewBoard from "../src/components/NewBoard";

export const dynamic = "force-dynamic";

export default async function Index() {
  const boards = await store.listBoards();
  return (
    <main className="index">
      <h1>Process maps</h1>
      <p className="lede">
        The whiteboard is the source language and the review agent is the language
        server. Start with the draft — it is drawn the way a domain expert actually
        draws it, so the compiler has something to say about it.
      </p>
      <NewBoard />

      {boards.map((b) => (
        <Link key={b.id} href={`/boards/${b.id}`} className="board-link">
          <div className="name">{b.title}</div>
          <div className="meta">{b.status}</div>
        </Link>
      ))}
      {boards.length === 0 && (
        <p className="lede">
          No boards. Run <code>npm run db:seed</code>.
        </p>
      )}
    </main>
  );
}
