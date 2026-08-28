-- What accepting a comment will DO, in her words.
--
-- "I clicked yes and it deleted my node" — the deletion was correct; the
-- surprise was the bug. The text is generated from the mutation rather than
-- written by a model, so it can never disagree with what actually happens.

alter table comments add column preview text;
