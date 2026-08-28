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


---

## Pass 2 — reapply the multi-value split; everything else halted again

**Starting score: 3/12** (2 scored passes `MNBU4371364`, `MMAU1407799`; 1
discarded `MNBU0458316`). New score left blank for the human to fill on re-run.

This pass reads the current `reports/eval.json`, which is the post-regeneration
report the note above predicted: `agent.py` no longer carries pass 1, so
`MNBU4407370` is red again with `invoices_failed: 0 → 4`.

### Classification of all nine failures

Metric map: `invoices_total` = count of `art_2`; `invoices_failed/successful` =
`pol_2` verdicts on `art_2`; `goods_failed` = `pol_1` verdicts on `art_4`;
`coa_total` = count of `art_3`.

| case | fx | signature | class |
|---|---|---|---|
| `MNBU4407370` | 1 | records exact (7/12); only `invoices_failed 0→4` | **logic-failure** — fixable in boundary |
| `HLBU6302759` | 1 | `coa 9=9` exact; `invoices_total 3→14`; `invoices_failed 0→2` | mixed: `invoices_failed` is the same logic-failure; `invoices_total` is extraction |
| `MCAU6047165` | 1 | `coa 14=14` exact; `invoices_total 11→18`; `invoices_failed 0→18` | mixed: `invoices_failed` is the logic-failure; `invoices_total` is extraction |
| `CAAU4056270` | 2 | `coa 5→10` (doubled); `invoices 1→9` | **extraction-failure** — spec-level |
| `MNBU3974949` | 2 | `coa 17→34` (doubled); `invoices 1→38` | **extraction-failure** — spec-level |
| `CGMU5630052` | 2 | `coa 3→6` (doubled); `invoices 1→6`; `goods_failed 0→9` | **extraction-failure** — spec-level |
| `TTNU8982561` | 1 | `invoices 2→9`; `coa 7→9` | **extraction-failure** — spec-level |
| `MNBU3852977` | 1 | `coa 6=6` exact; `invoices 3→6`; `invoices_failed 3→0`; `goods_failed 6→4` | **extraction-failure** + missing propagation — spec-level |
| `020-07721814` | 1 | `coa 4→3` (under-extraction); `invoices 3→4`; `invoices_failed 0→1` | **extraction-failure** — spec-level |

### Root cause per case, in one line

- `MNBU4407370` — every `art_2` record extracted exactly (7) and every `art_3`
  exactly (12); the four invoices marked failed are precisely the four whose
  `Batch Number` is a comma-joined multi-value string (`"FMB226006A,
  FMB226007A"` etc.), and `exists_matching` compared the whole joined string to
  a single CoA number, which can never match. This is the only pure
  logic-failure and it is fixable in the boundary.
- `HLBU6302759` / `MCAU6047165` — `coa_total` matches exactly, so `art_3` is
  right; the `invoices_failed` discrepancy is the same joined-string bug, so the
  split below removes it. Their `invoices_total` over-count is a separate
  extraction cause (below) and is *not* fixed here.
- `CAAU4056270`, `MNBU3974949`, `CGMU5630052` (all 2 fixtures) — `coa_total` is
  exactly doubled and the two fixtures carry the *same* invoice number; nothing
  deduplicates because `compiled.identity_merges` is empty and `art_2` has no
  `identity_key`. Extraction is faithfully returning both copies.
- `TTNU8982561`, `MNBU3852977`, `020-07721814` — single fixture, yet `art_2`
  count exceeds the invoice count because the batch is modelled as a field on
  the invoice: one `art_2` row is emitted per batch line rather than per
  invoice. `020-07721814` additionally under-extracts one CoA (`coa 4→3`), and
  `MNBU3852977` expects `invoices_failed: 3` that no run can produce because no
  edge propagates a good's failure up to its invoice.

### Diff — `pol_2` step of `processes/final_test/agent/agent.py`

```diff
-            _ok = relations.exists_matching(_subject, _candidates, key=squash)
+            _parts = [_p for _p in str(_subject).split(",") if _p.strip()]
+            _ok = all(relations.exists_matching(_p, _candidates, key=squash) for _p in _parts)
```

This is pass 1's fix, verbatim in behaviour. It is stricter, not wider — every
real batch value must match a CoA — so it does not violate "never widen a
comparison to make a case pass." `runtime/` is untouched; the split and the
comparison are passed into the relation as data. Expected effect: `MNBU4407370`
green; `HLBU6302759` and `MCAU6047165` lose their `invoices_failed` discrepancy
(they stay red on `invoices_total`).

### Halted again — the same four spec-level findings

The eight remaining failures reduce to the four spec-level causes named in pass
1 (no `identity_key` on `art_2`; batch modelled as a field not an artifact;
`art_4` field names `ACDA/SDF/EDF` that appear in no document, so `present`
always fails; no failure-propagation edge from `art_4` to `art_2`), plus the
trailing-letter ambiguity (`UCB26009` vs `UCB26009A`) that needs a human ruling.
None is patchable inside `processes/<id>/agent/` without inventing a rule the
board never gave. **Next action is a review round and a re-freeze, not another
heal pass.** Per the standing note above, whoever regenerates must re-read this
log or the split will be discarded a third time.

**Score after re-run: __ / 12** (human fills in).
