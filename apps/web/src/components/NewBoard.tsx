"use client";

// Start from nothing. There is no SOP to transcribe and no template to pick —
// the whiteboard is where the process gets written for the first time, so a
// new board is genuinely blank and the compiler has plenty to say about it.

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createBoard } from "../actions";

export default function NewBoard() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [pending, start] = useTransition();

  return (
    <div className="new-board">
      <input
        value={title}
        placeholder="Name a process you own — then draw it"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && title.trim()) go();
        }}
      />
      <button className="primary" disabled={pending || !title.trim()} onClick={go}>
        New blank board
      </button>
    </div>
  );

  function go() {
    start(async () => {
      const id = await createBoard(title.trim());
      router.push(`/boards/${id}`);
    });
  }
}
