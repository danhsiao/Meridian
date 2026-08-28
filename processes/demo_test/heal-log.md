# heal log — demo_test

## Pass 1

Started from **7/12** (1 discarded, `coa_success` not scored).

Five failures, two root causes. One is patchable inside `agent/`; the other is
not, and is recorded here rather than worked around.

### Not patched — no `identity_key` on `art_2` (spec-level)

`CAAU4056270`, `MNBU3974949`, `CGMU5630052` — every case whose shipment arrived
as **two** fixtures, and no case that arrived as one.

Classification: **extraction-failure**. Evidence, from
`extracted_state.records.art_2` on `CAAU4056270`:

    {"Invoice No": "U03/25-26/4790"}   source 1a0027e70a8874f6
    {"Invoice No": "U03/25-26/4790"}   source 1a0027e4259de8e8

The same invoice, extracted once per forwarded copy of the message. Every count
downstream doubles exactly: `invoices_total` 1→2, `coa_total` 5→10 and 17→34,
`goods_failed` 2→6.

Root cause: `compiled.identity_merges` carries `art_3` on `Batch No` and nothing
for `art_2`, so two copies of one invoice stay two records. The board never set
an `identity_key` on Invoices.

**Halted.** Merging records the spec did not ask to merge would green three
cases and break the property that generated code is traceable to a spec hash.
The fix is a review round on the board — set `identity_key: "Invoice No"` on
Invoices, which is already its only declared field — then re-freeze and
regenerate.

### Patched — `art_3` had nothing telling it which attachment to read

`MCAU6047165`, `020-07721814` — `failed_coa` expected 1, got 0 in both.

Classification: **extraction-failure**. Evidence: `art_4` (Batch, read out of
the invoice) and `art_3` (CoAs, read out of the email) came back as identical
lists —

    MCAU6047165   art_4: 14 values   art_3: the same 14 values, same order
    020-07721814  art_4:  4 values   art_3: the same 4 values, same order

A perfect 1:1 makes `exists_matching` structurally incapable of failing, so
`failed_coa` can only be 0. `coa_total` passed in both cases, so the labels
agree there are 14 and 4 certificates — one of them simply does not correspond
to a batch. `art_3` mirrored the invoice's batch table instead of reading the
certificate documents.

`CAAU4056270` shows this is not universal: there `art_3` returned `UCB26009`
against `art_4`'s `UCB26009A`, which is two different documents transcribed by
two different people.

Root cause: `art_2` and `art_3` are both extracted from `art_1`, and neither
carries a `source_hint`, so the extraction prompt has nothing that distinguishes
one attachment from the other.

Diff — one call site, `processes/demo_test/agent/agent.py`:

```diff
-                fields=_config.get("fields"), source_hint=_config.get("source_hint"),
+                fields=_config.get("fields"),
+                source_hint=_config.get("source_hint") or _config.get("describes"),
```

`describes` on `art_3` is `"CoAs are pdfs from email"` — her words, already in
the frozen spec. The patch passes spec data to a parameter that was reading
`None`; it adds no domain knowledge of its own, touches no runtime verb, and is
scoped to `art_3` so the other four extractions keep their cached prompts.
`verify_generated`: clean.

### Standing gap this exposes

The compiler requires `source_hint` when sibling artifacts derive from the same
**channel** (`sibling_artifacts_from_same_channel`). These two derive from the
same **artifact**, so the condition never fired and the board froze without one.
That is a missing conditional, not a bad answer — the operator was never asked.

### Pass 1 result — 3/12. Patch reverted.

The hint made it worse, and the way it failed says why.

`coa_total` went to **0** on six cases that had been reading certificates fine
(`TTNU8982561` 7→0, `MNBU3852977` 6→0, `MNBU4407370` 12→0, `HLBU6302759` 9→0,
`MCAU6047165` 14→0). `failed_coa` then exploded — 10, 34, 8, 12, 14 — because
with no certificates extracted at all, every batch fails to find one.

So the hint did not point `art_3` at a different document. It stopped it finding
any document. `"CoAs are pdfs from email"` is a sentence written to describe a
card to a human; as a `Where to find them:` instruction it narrowed the
extraction to nothing. Her prose and an extraction directive are not the same
kind of string, and treating one as the other is the mistake.

`MCAU6047165` and `020-07721814` — the two cases the patch was aimed at — did
not improve at either score.

**Reverted.** `agent/agent.py` is byte-identical to what `cli gen` emitted;
`verify_generated` is clean. Score returns to **7/12**.

### What this pass actually established

Both remaining failure classes are spec-level, and neither is reachable from
inside `agent/`:

1. **`art_2` has no `identity_key`** — three cases double-count. Unchanged.
2. **`art_3` and `art_2` are siblings off `art_1` with no `source_hint`** — and
   this pass demonstrated that the gap cannot be closed by reusing `describes`.
   The board has to say which attachment is which, in the words of an extraction
   hint, which means being *asked* — and the compiler never asks, because
   `sibling_artifacts_from_same_channel` tests a shared channel and these share
   an artifact.

The second finding is the more interesting one for the compiler: the condition
is too narrow, and a board can freeze with two indistinguishable extractions off
one parent. That is a new Pass A check, not a heal.
