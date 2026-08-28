# heal log — demoboard

## Pass 1

**Score going in:** 1/12 (1 discarded) — the 1 is the discarded case, which the
runner counts as a pass. No scored case passed.

**Score coming out:** _(filled in by the human after re-running `cli eval`)_

### Failing cases and root cause

Every failure classified as **extraction-failure**. `extracted_state.verdicts`
behaves correctly throughout; `extracted_state.records["art_2"]` is wrong, and
the policy verdicts are downstream of that.

| case | failing metrics | root cause |
|---|---|---|
| TTNU8982561 | `coa_total`, `coa_success` | `art_2` empty (0 rows) while `art_4` holds 7 batches — the spec's `source_hint` matched no document in the payload |
| MNBU4371364 | `coa_total`, `coa_success` | same; `art_2` 0 rows against 3 batches |
| MNBU3852977 | `coa_total`, `coa_success` | same; `art_2` 0 rows against 6 batches |
| MNBU4407370 | `coa_total`, `coa_success` | same; `art_2` 0 rows against 12 batches |
| HLBU6302759 | `coa_total`, `coa_success` | same; `art_2` 0 rows against 9 batches |
| MCAU6047165 | `coa_total`, `failed_coa`, `coa_success` | same; `art_2` 0 rows against 14 batches |
| CAAU4056270 | `failed_coa`, `coa_success`, `goods_failed` | `art_2` extracted `UCB26009`, `UCB26018`… where `art_4` holds `UCB26009A`, `UCB26018A`… — trailing suffix dropped, so `pol_2`'s `Batch No` join missed all 5 |
| MNBU3974949 | `failed_coa`, `coa_success` | same truncation; `AALD26001` against `AALD26001A`, all 17 certificates failed |
| MMAU1407799 | `failed_coa`, `coa_success` | `art_2` extracted a single row with `Batch No: None`, so `on_absent: fail` fired |
| 020-07721814 | `coa_total`, `failed_coa` | `art_2` found 3 of 4 certificates; the missing one (`3OP26004A`) is the one the labels expect to fail |
| CGMU5630052 | `invoices_failed`, `invoices_successful`, `goods_failed` | not a CoA case — `pol_1` failed 3 goods the labels pass, and that verdict propagated up `e_7` to flip the invoice |

**The control that makes this a diagnosis rather than a guess:** the two cases
where `art_2` already carried the full suffix — CGMU5630052 (`SM8726049A`) and
020-07721814 (`3EL26022A`) — are exactly the two whose `coa_*` metrics pass.
The suffix is the variable that moves with the outcome.

### Diff

`processes/demoboard/agent/agent.py`, `art_2` extraction only. An
`extraction_hint` is now passed where the generated code passed
`_config.get("extraction_hint")` (which was `None` — the spec sets none for
`art_2`):

```python
_COA_HINT = (
    "Certificates of analysis. A certificate may be a standalone PDF or carried "
    "inside a combined document -- COC, 'COC & USDA', 'COC&COA', 'Final FP COA', "
    "'Uncontrolled COA'. Emit one row per certificate. Copy 'Batch No' exactly as "
    "printed, including any trailing letter suffix: 'UCB26009A', not 'UCB26009'."
)
```

Two things deliberately **not** touched:

- `pol_2`'s relation and its `key=squash` comparison. Widening the match until
  `UCB26009` meets `UCB26009A` would make the cases pass without the agent ever
  reading the right value, and would also make two genuinely different batches
  compare equal. The difference is an extraction artifact, not a real difference
  between the documents — CGMU5630052 proves the certificates do print the
  suffix — so the fix belongs in extraction.
- `expected/`, the frozen spec, and `runtime/`.

### Caveat on scope

For the six empty-`art_2` cases the root cause is stated from
`extracted_state` alone: the hint matched nothing. I did not read the fixture
text to confirm a certificate document is actually present in those payloads.
If it turns out there is none, no hint can produce the expected counts and the
finding is a spec/label disagreement rather than an agent defect — that would
be a `halt`, not a patch. The two truncation cases and MMAU1407799 are
diagnosed from the extracted values directly and do not carry that caveat.
