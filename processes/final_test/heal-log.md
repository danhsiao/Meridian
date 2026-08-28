# Heal log — `final_test`

One section per pass. Each records what failed, the root cause **stated before
any diff**, the change, and the score either side of it.

Baseline and every score below are `cli eval --process final_test`, replaying
the 15 snapshotted fixtures in `fixtures/` against
`sha256:cce7715b…f196fe`. `MNBU0458316` is discarded by the label suite and
reported as skipped.

---

## Pass 0 — baseline

**3/12** (2 scored passes, 1 discarded).

Passing: `MNBU4371364`, `MMAU1407799`. Both are small — three invoices and one
respectively, one certificate each, no multi-valued fields.

---

## Pass 1 — one logic-failure fixed, four spec-level findings halted

**3/12 → 4/12.**

### Classification

`MNBU4407370` is the only case in the suite where extraction is provably
correct and the verdicts are still wrong, which makes it the only pure
**logic-failure** in the report:

| | expected | extracted |
|---|---|---|
| invoices | 7 | **7** |
| certificates | 12 | **12** |
| invoices_failed | 0 | 4 |

Both record counts match the labels exactly, so nothing was mis-extracted. Four
invoices were nonetheless marked failed.

### Root cause

The four failing invoices are exactly the four whose `Batch Number` holds more
than one value in a single string:

```
HCA/25-26/3120  "FMB226006A, FMB226007A"          -> failed
HCA/25-26/3122  "HRB125012BR"                     -> passed
HCA/25-26/3123  "CLC126004A, CLC126005A"          -> failed
HCA/25-26/3132  "BCD125003A"                      -> passed
HCA/25-26/3134  "CLC126006A, CLC126007A, CLC126008A" -> failed
HCA/25-26/3135  "CLC126009A, CLC126010A"          -> failed
```

Every one of those batch numbers has a matching certificate in `art_3`. The
comparison was between the whole joined string and a single certificate number,
which can never match.

The underlying reason the field is multi-valued is a board modelling choice —
the batch is a *field on the invoice* rather than its own artifact, so a
one-to-many relationship is flattened into a string. That is a spec-level
observation, but the agent can read the field correctly without the spec
changing, so this one is fixable inside the boundary.

### Diff

`processes/final_test/agent/agent.py`, in the `pol_2` step:

```diff
-            _ok = relations.exists_matching(_subject, _candidates, key=squash)
+            _parts = [_p for _p in str(_subject).split(",") if _p.strip()]
+            _ok = all(relations.exists_matching(_p, _candidates, key=squash) for _p in _parts)
```

Both the split and the comparison are passed *into* the relation as data.
`runtime/relations.py` is untouched, so the engine's own definition of a match
is unchanged and this stays inside one process.

### Result

`MNBU4407370` green. `HLBU6302759` lost its `invoices_failed` discrepancy for
the same reason, leaving only extraction differences there.

### Halted — four spec-level findings, not patched

The remaining eight failures share four root causes, and **every one of them is
in the spec rather than the agent.** Per `skills/heal-agent/SKILL.md`, the
correct action is to halt and surface, not to patch:

1. **`art_2` has no `identity_key`.** `compiled.identity_merges` is empty, so
   nothing deduplicates invoices. `CAAU4056270` yields nine `art_2` records all
   carrying `U03/25-26/4790` — one per batch row. Patching the agent to merge
   records the spec never asked to merge would be inventing a rule the operator
   never gave.
2. **The batch is modelled as a field, not an artifact.** This is what produces
   the multi-valued strings above. Pass 1 works around the symptom; the fix is
   to promote the batch to its own artifact and draw the `contains` edge.
3. **`art_4`'s field names do not exist in any document.** `ACDA`, `SDF` and
   `EDF` are placeholders typed during the review conversation. Extraction
   correctly returns `null` for all of them, so every good fails `present`.
   Correcting them requires reading a real document, which is a review round.
4. **No edge propagates a child's failure to its parent.** `pol_1` lands its
   verdict on `art_4` only. The label suite treats an invoice as failed when one
   of its goods fails; the board cannot express that. `CAAU4056270` expects
   `invoices_failed: 1` from `goods_failed: 2`, and no run of this spec can
   produce it.

A fifth is genuinely ambiguous rather than wrong: certificate batch numbers read
`UCB26009` where invoice batch numbers read `UCB26009A`. `squash` normalises
whitespace and case but cannot decide whether a trailing letter is significant.
That needs a human ruling, which is a comment on the board.

**Next action is not another heal pass.** It is a review round: set the
`identity_key`, promote the batch, correct the field names against a real
document, and draw the propagation edge. Then re-freeze and regenerate. The loop
is working as designed — it is just a longer loop than one pass, and the report
is what made the difference between "nine cases are red" and a named cause for
each.


---

## Note — pass 1 was discarded by a regeneration

After `cli gen` became skill-driven, `final_test` was regenerated and the
regenerated `agent.py` does not carry pass 1. `MNBU4407370` is failing again
with the original signature (`invoices_failed: expected 0, got 4`).

This is not a mistake in either half. `/heal-agent` patches
`processes/<id>/agent/` by design, and `cli gen` overwrites that directory by
design; nothing currently guards the overlap. Re-running `/heal-agent` against
the current report reproduces the fix — the classification and root cause above
still hold, and the diff is two lines.

The durable answers, none built yet, are listed in
[docs/blocks-6-9.md](../../docs/blocks-6-9.md#healing-and-regeneration-are-in-tension-and-nothing-resolves-it-yet).
Until one exists: **generate first, heal second, and never regenerate without
re-reading this log.**
