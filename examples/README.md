# `examples/`

Seed boards. Both `receiving.json` and `loan_file.json` elaborate to zero
findings and freeze to a stable hash, and `tests/examples.test.ts` asserts it —
that pair is the generality proof: two unrelated industries, one compiler, one
registry.

## `on_child_fail` is `"ignore"` here, and that is a fixture decision

Every `contains` edge in these files carries `"on_child_fail": "ignore"`.

That value was chosen because it is **behaviour-preserving**: these fixtures were
written before the key existed, and `"fail_parent"` would silently change what
they assert — a parent that used to be judged only by its own checks would start
inheriting its children's verdicts, and several expected counts would move
without anyone editing an expectation.

**A real board answers this question through review**, where the operator is
asked, in their own words:

> Each *&lt;parent&gt;* contains *&lt;child&gt;*. If a *&lt;child&gt;* fails a check, does the
> *&lt;parent&gt;* fail too?

A fixture inheriting a default is not the same thing as a person answering, and
these files should not be read as evidence that `"ignore"` is the common answer.
It is the answer that keeps a test honest.
