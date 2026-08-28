-- A comment must outlive the node it points at.
--
-- `demote_to_field` deletes the node it collapses. With ON DELETE CASCADE the
-- comment that PROPOSED the collapse was deleted the instant she accepted it —
-- so the loop erased its own history, and `frozen_specs.provenance.comments`
-- would reference rows that no longer exist.
--
-- The anchor stays a plain reference. A comment whose node is gone is simply a
-- resolved comment with nowhere to pin, which the renderer already handles: it
-- shows in the queue and not on the canvas. "Six months on, every structural
-- choice traces to a question, an answer, and a name" requires exactly this.

alter table comments drop constraint comments_map_id_node_id_fkey;
alter table comments drop constraint comments_map_id_edge_id_fkey;

-- Still exactly one anchor, still never zero — the invariant that keeps a
-- diagnostic attached to a location is unchanged. Only the cascade is gone.
